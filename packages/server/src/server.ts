#!/usr/bin/env node
import { createBirpc, type BirpcReturn } from "birpc";
import corsMiddleware from "cors";
import JSON5 from "json5";
import * as Path from "node:path";
import type { ViteDevServer } from "vite";
import { createServer as createViteServer, send } from "vite";
import { ESModulesRunner, ViteRuntime } from "vite/runtime";
import { WebSocketServer, type WebSocket } from "ws";
import rewrite from "./rewrite";
import type { CellOutput, ClientFunctions, ServerFunctions } from "./types";
import { Options, SourceDescription } from "./types";

const trailingSeparatorRE = /[?&]$/;
const timestampRE = /\bt=\d{13}&?\b/;
function removeTimestampQuery(url: string): string {
  return url.replace(timestampRE, "").replace(trailingSeparatorRE, "");
}

interface PossibleSVG {
  outerHTML: string;
}

function isSVGElementLike(obj: unknown): obj is PossibleSVG {
  return (
    obj !== null &&
    typeof obj === "object" &&
    "outerHTML" in obj &&
    typeof obj.outerHTML === "string" &&
    obj.outerHTML.startsWith("<svg")
  );
}

interface PossibleHTML {
  outerHTML: string;
}

function isHTMLElementLike(obj: unknown): obj is PossibleHTML {
  return (
    obj !== null &&
    typeof obj === "object" &&
    "outerHTML" in obj &&
    typeof obj.outerHTML === "string"
  );
}

const cellIdRegex = /^([^?]+\.vnb)\?cellId=([a-zA-z0-9_-]{21})\.([a-z]+)$/;

class VitaleDevServer {
  static async construct(options: Options) {
    const cells: Map<string, SourceDescription> = new Map();
    const viteServer = await createViteServer({
      server: {
        port: options.port,
        host: "127.0.0.1",
        strictPort: true,
        origin: `http://127.0.0.1:${options.port}`,
      },
      plugins: [
        {
          name: "vitale",
          resolveId(source) {
            return cells.has(source) ? source : null;
          },
          load(id) {
            return cells.has(id) ? cells.get(id)!.code : null;
          },

          configureServer(server) {
            server.middlewares.use(corsMiddleware({}));

            // this is the core of `transformMiddleware` from vite
            // we must reimplement it in order to serve `.vnb?cellId` paths
            server.middlewares.use(async (req, res, next) => {
              if (req.url) {
                const url = removeTimestampQuery(req.url);
                if (cellIdRegex.test(url)) {
                  const result = await server.transformRequest(url);
                  if (result) {
                    return send(req, res, result.code, "js", {
                      etag: result.etag,
                      cacheControl: "no-cache",
                      headers: server.config.server.headers,
                      map: result.map,
                    });
                  }
                }
              }
              next();
            });
          },
        },
      ],
    });

    return new VitaleDevServer(viteServer, cells);
  }

  private viteServer: ViteDevServer;
  private viteRuntime: ViteRuntime;
  private clients: Map<
    WebSocket,
    BirpcReturn<ClientFunctions, ServerFunctions>
  > = new Map();
  private cells: Map<string, SourceDescription>;

  private constructor(
    viteServer: ViteDevServer,
    cells: Map<string, SourceDescription>
  ) {
    this.viteServer = viteServer;
    this.cells = cells;

    this.viteRuntime = new ViteRuntime(
      {
        root: viteServer.config.root,
        fetchModule: viteServer.ssrFetchModule,
      },
      new ESModulesRunner()
    );

    const wss = new WebSocketServer({ noServer: true });

    viteServer.httpServer?.on("upgrade", (request, socket, head) => {
      if (!request.url) return;
      const { pathname } = new URL(request.url, "http://localhost");
      if (pathname !== "/__vitale_api__") return;
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
        this.setupClient(ws);
      });
    });

    viteServer.watcher.on("change", (id) => {
      this.invalidateModule(id);
    });

    viteServer.watcher.on("add", (id) => {
      this.invalidateModule(id);
    });
  }

  private async executeCell(id: string, path: string, cellId: string) {
    // TODO(jaked)
    // await so client finishes startCellExecution before we send endCellExecution
    // would be better for client to lock around startCellExecution
    await Promise.all(
      Array.from(this.clients.values()).map((client) =>
        client.startCellExecution(path, cellId)
      )
    );

    let data;
    let mime;

    // client execution
    if (this.cells.get(id)?.type === "client") {
      data = JSON.stringify({
        // TODO(jaked) strip workspace root when executeCell is called
        id: id.substring(this.viteServer.config.root.length + 1),
        origin: this.viteServer.config.server.origin,
      });
      mime = "application/x-vitale";
    }

    // server execution
    else {
      try {
        let { default: result } = await this.viteRuntime.executeUrl(id);
        if (result instanceof Promise) result = await result;
        if (
          typeof result === "object" &&
          "data" in result &&
          typeof result.data === "string" &&
          "mime" in result &&
          typeof result.mime === "string"
        ) {
          mime = result.mime;
          data = result.data;
        } else if (isSVGElementLike(result)) {
          mime = "image/svg+xml";
          data = result.outerHTML;
        } else if (isHTMLElementLike(result)) {
          mime = "text/html";
          data = result.outerHTML;
        } else if (typeof result === "object") {
          mime = "application/json";
          data = JSON.stringify(result);
        } else {
          mime = "text/x-javascript";
          data = JSON.stringify(result);
        }
      } catch (e) {
        const err = e as Error;
        const obj = {
          name: err.name,
          message: err.message,
          stack: err.stack,
        };
        data = JSON.stringify(obj, undefined, "\t");
        mime = "application/vnd.code.notebook.error";
      }
    }

    const cellOutput: CellOutput = {
      items:
        data === undefined
          ? []
          : [{ data: [...Buffer.from(data, "utf8").values()], mime }],
    };

    return await Promise.all(
      Array.from(this.clients.values()).map((client) =>
        client.endCellExecution(path, cellId, cellOutput)
      )
    );
  }

  private invalidateModule(id: string) {
    const mod = this.viteRuntime.moduleCache.get(id);
    this.viteRuntime.moduleCache.delete(id);

    const match = cellIdRegex.exec(id);
    if (match) {
      const [_, path, cellId] = match;
      this.executeCell(id, path, cellId);
    }

    for (const dep of mod.importers ?? []) {
      this.invalidateModule(Path.join(this.viteServer.config.root, dep));
    }
  }

  private executeCellRPC(
    path: string,
    cellId: string,
    language: string,
    code: string
  ) {
    const ext = (() => {
      switch (language) {
        case "typescriptreact":
          return "tsx";
        case "typescript":
          return "ts";
        case "javascriptreact":
          return "jsx";
        case "javascript":
          return "js";
        default:
          throw new Error(`unknown language "${language}"`);
      }
    })();
    const id = `${path}?cellId=${cellId}.${ext}`;
    this.cells.set(id, rewrite(code, language, cellId));

    const mod = this.viteServer.moduleGraph.getModuleById(id);
    if (mod) this.viteServer.moduleGraph.invalidateModule(mod);

    this.invalidateModule(id);
  }

  private setupClient(ws: WebSocket) {
    const self = this;
    const rpc = createBirpc<ClientFunctions, ServerFunctions>(
      {
        ping: async () => {
          console.log("ping");
          return "pong";
        },
        executeCell(path, cellId, language, code) {
          return self.executeCellRPC(path, cellId, language, code);
        },
      },
      {
        post: (msg) => ws.send(msg),
        on: (fn) => ws.on("message", fn),
        serialize: (v) => JSON5.stringify(v),
        deserialize: (v) => JSON5.parse(v),
      }
    );

    this.clients.set(ws, rpc);
    ws.on("close", () => {
      this.clients.delete(ws);
    });
  }

  listen() {
    this.viteServer.listen();
  }
}

export function createServer(opts: { port: number }) {
  return VitaleDevServer.construct(opts);
}