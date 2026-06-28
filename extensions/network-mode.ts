/**
 * Network mode extension.
 *
 * Exposes runtime network mode controls through a tool and slash command.
 * The extension delegates privileged switching to /usr/local/bin/network-mode
 * via sudo, which is constrained by /config/sudo-allowlist.txt.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const NETWORK_MODE_TOOL = "network_mode";
const NETWORK_MODE_MESSAGE_TYPE = "network_mode_state";
const MODE_SWITCH_SCRIPT = "/usr/local/bin/network-mode";

type ModeName = "allowlist" | "open-get";

type ActionName = "status" | "set";

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

function normalizeMode(input: string | undefined): ModeName | null {
  if (input === "allowlist" || input === "open-get") {
    return input;
  }
  return null;
}

async function runPrivileged(pi: ExtensionAPI, args: string[]): Promise<ExecResult> {
  return (await pi.exec("bash", ["-lc", `sudo ${MODE_SWITCH_SCRIPT} ${args.join(" ")}`])) as ExecResult;
}

async function readStatus(pi: ExtensionAPI): Promise<{ ok: boolean; result: ExecResult; parsed?: any }> {
  const result = await runPrivileged(pi, ["status", "--json"]);
  if (result.code !== 0) {
    return { ok: false, result };
  }

  try {
    const parsed = JSON.parse(result.stdout || "{}");
    return { ok: true, result, parsed };
  } catch {
    return { ok: true, result };
  }
}

function statusText(parsed: any): string {
  if (!parsed || typeof parsed !== "object") {
    return "Unable to read runtime network mode state.";
  }

  const mode = parsed.mode ?? "unknown";
  const dnsmasqConf = parsed.dnsmasqConf ?? "unknown";
  const squidConf = parsed.squidConf ?? "unknown";
  const rewrite = parsed.urlRewriteEnabled === true ? "enabled" : "disabled";

  return [
    `Current network mode: ${mode}`,
    `dnsmasq config: ${dnsmasqConf}`,
    `squid config: ${squidConf}`,
    `URL rewrite in open-get: ${rewrite}`,
  ].join("\n");
}

function emitState(pi: ExtensionAPI, parsed: any) {
  if (!parsed || typeof parsed !== "object") return;
  pi.sendMessage({
    customType: NETWORK_MODE_MESSAGE_TYPE,
    content: "",
    display: false,
    details: parsed,
  });
}

export default function networkModeExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: NETWORK_MODE_TOOL,
    label: "Network Mode",
    description:
      "Read or change runtime network sandbox mode. " +
      "Modes: allowlist (strict) and open-get (read-only web research).",
    promptSnippet: "Read or switch the active network sandbox mode",
    promptGuidelines: [
      "Use action=status to inspect current runtime network mode before network-heavy operations.",
      "Use action=set with mode=allowlist for write operations to allowlisted domains (for example git push).",
      "Use action=set with mode=open-get for read-only broad-domain research.",
    ],
    parameters: Type.Object({
      action: Type.String({
        description: "status or set",
      }),
      mode: Type.Optional(
        Type.String({
          description: "Required when action=set. Values: allowlist, open-get",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const action = (params.action ?? "status") as ActionName;

      if (action !== "status" && action !== "set") {
        return {
          content: [{ type: "text", text: "Invalid action. Use status or set." }],
          details: {},
        };
      }

      if (action === "status") {
        const status = await readStatus(pi);
        if (!status.ok) {
          return {
            content: [
              {
                type: "text",
                text: `Failed to read network mode.\n${status.result.stderr || status.result.stdout || "No output."}`,
              },
            ],
            details: { code: status.result.code },
          };
        }

        emitState(pi, status.parsed);
        return {
          content: [{ type: "text", text: statusText(status.parsed) }],
          details: status.parsed ?? {},
        };
      }

      const mode = normalizeMode(params.mode);
      if (!mode) {
        return {
          content: [{ type: "text", text: "Invalid or missing mode. Use allowlist or open-get." }],
          details: {},
        };
      }

      const setResult = await runPrivileged(pi, ["set", mode]);
      if (setResult.code !== 0) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to switch network mode to ${mode}.\n${setResult.stderr || setResult.stdout || "No output."}`,
            },
          ],
          details: { code: setResult.code, mode },
        };
      }

      const status = await readStatus(pi);
      if (status.ok) {
        emitState(pi, status.parsed);
      }

      return {
        content: [
          {
            type: "text",
            text: [
              `Runtime network mode switched to ${mode}.`,
              status.ok ? "" : setResult.stdout.trim(),
              status.ok ? statusText(status.parsed) : "",
            ]
              .filter(Boolean)
              .join("\n"),
          },
        ],
        details: status.ok ? status.parsed ?? { mode } : { mode },
      };
    },
  });

  pi.registerCommand("network", {
    description: "Network mode control: /network state | /network switch <allowlist|open-get>",
    handler: async (args, ctx: ExtensionContext) => {
      const argv = String(args ?? "")
        .split(/\s+/)
        .map((token) => token.trim())
        .filter((token) => token.length > 0);

      const subcommand = (argv[0] ?? "state").toLowerCase();
      if (subcommand === "state") {
        const status = await readStatus(pi);
        if (!status.ok) {
          ctx.ui.notify(
            `Failed to read network mode: ${status.result.stderr || status.result.stdout || "No output."}`,
            "warning",
          );
          return;
        }
        emitState(pi, status.parsed);
        ctx.ui.notify(statusText(status.parsed), "info");
        return;
      }

      if (subcommand === "switch") {
        const mode = normalizeMode(argv[1]);
        if (!mode) {
          ctx.ui.notify("Usage: /network switch <allowlist|open-get>", "warning");
          return;
        }

        const result = await runPrivileged(pi, ["set", mode]);
        if (result.code !== 0) {
          ctx.ui.notify(
            `Failed to switch mode: ${result.stderr || result.stdout || "No output."}`,
            "warning",
          );
          return;
        }

        const status = await readStatus(pi);
        if (status.ok) {
          emitState(pi, status.parsed);
          ctx.ui.notify(`Switched network mode to ${mode}.\n${statusText(status.parsed)}`, "info");
        } else {
          ctx.ui.notify(`Switched network mode to ${mode}.`, "info");
        }
        return;
      }

      ctx.ui.notify("Usage: /network state | /network switch <allowlist|open-get>", "warning");
    },
  });

  pi.on("session_start", async () => {
    const status = await readStatus(pi);
    if (status.ok) {
      emitState(pi, status.parsed);
    }
  });

  pi.on("session_tree", async () => {
    const status = await readStatus(pi);
    if (status.ok) {
      emitState(pi, status.parsed);
    }
  });
}
