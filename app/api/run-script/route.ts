import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { NextResponse } from "next/server";

const execFileAsync = promisify(execFile);
export const runtime = "nodejs";
export const maxDuration = 300;
const routeDir = path.dirname(fileURLToPath(import.meta.url));

const ALLOWED_SCRIPTS = {
  upload_orders_to_retailcrm: {
    label: "upload_orders_to_retailcrm.py",
    absolutePath: path.resolve(routeDir, "../../../upload_orders_to_retailcrm.py"),
  },
  sync_retailcrm_to_supabase: {
    label: "sync_retailcrm_to_supabase.py",
    absolutePath: path.resolve(routeDir, "../../../sync_retailcrm_to_supabase.py"),
  },
} as const;

type AllowedScriptName = keyof typeof ALLOWED_SCRIPTS;

function isAllowedScriptName(value: unknown): value is AllowedScriptName {
  return typeof value === "string" && value in ALLOWED_SCRIPTS;
}

function getPythonCommands(): string[] {
  const configured = process.env.PYTHON_EXECUTABLE?.trim();
  return configured ? [configured] : ["python3", "python"];
}

export async function POST(request: Request) {
  let payload: unknown;

  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const scriptName = (payload as { script?: unknown })?.script;
  if (!isAllowedScriptName(scriptName)) {
    return NextResponse.json({ error: "Unsupported script requested." }, { status: 400 });
  }

  const script = ALLOWED_SCRIPTS[scriptName];

  try {
    await access(script.absolutePath);
  } catch {
    return NextResponse.json(
      {
        ok: false,
        script: script.label,
        message:
          "The requested script is not available in the deployed server bundle. Check Next.js output file tracing settings.",
      },
      { status: 500 },
    );
  }

  try {
    let lastError: unknown = null;

    for (const pythonCommand of getPythonCommands()) {
      try {
        const { stdout, stderr } = await execFileAsync(pythonCommand, [script.absolutePath], {
          cwd: process.cwd(),
          timeout: 10 * 60 * 1000,
          maxBuffer: 1024 * 1024 * 4,
        });

        return NextResponse.json({
          ok: true,
          script: script.label,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
        });
      } catch (error) {
        lastError = error;

        const errorCode =
          typeof error === "object" && error !== null && "code" in error
            ? String((error as { code?: unknown }).code ?? "")
            : "";

        if (errorCode !== "ENOENT") {
          throw error;
        }
      }
    }

    throw lastError ?? new Error("No Python executable was found.");
  } catch (error) {
    const details =
      typeof error === "object" && error !== null
        ? {
            stdout: typeof (error as { stdout?: unknown }).stdout === "string"
              ? (error as { stdout: string }).stdout.trim()
              : "",
            stderr: typeof (error as { stderr?: unknown }).stderr === "string"
              ? (error as { stderr: string }).stderr.trim()
              : "",
            message: error instanceof Error ? error.message : "Unknown error",
          }
        : {
            stdout: "",
            stderr: "",
            message: "Unknown error",
          };

    return NextResponse.json(
      {
        ok: false,
        script: script.label,
        ...details,
      },
      { status: 500 },
    );
  }
}
