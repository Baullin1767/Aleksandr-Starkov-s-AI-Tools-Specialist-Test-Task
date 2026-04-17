import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NextResponse } from "next/server";

const execFileAsync = promisify(execFile);

const ALLOWED_SCRIPTS = {
  upload_orders_to_retailcrm: "upload_orders_to_retailcrm.py",
  sync_retailcrm_to_supabase: "sync_retailcrm_to_supabase.py",
} as const;

type AllowedScriptName = keyof typeof ALLOWED_SCRIPTS;

function isAllowedScriptName(value: unknown): value is AllowedScriptName {
  return typeof value === "string" && value in ALLOWED_SCRIPTS;
}

function getPythonCommand(): string {
  return process.env.PYTHON_EXECUTABLE || "python";
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

  const scriptPath = ALLOWED_SCRIPTS[scriptName];

  try {
    const { stdout, stderr } = await execFileAsync(getPythonCommand(), [scriptPath], {
      cwd: process.cwd(),
      timeout: 10 * 60 * 1000,
      maxBuffer: 1024 * 1024 * 4,
    });

    return NextResponse.json({
      ok: true,
      script: scriptPath,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
    });
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
        script: scriptPath,
        ...details,
      },
      { status: 500 },
    );
  }
}
