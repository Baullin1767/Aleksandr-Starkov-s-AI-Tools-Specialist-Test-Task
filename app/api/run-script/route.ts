import { NextResponse } from "next/server";
import { run as runSync } from "../../../sync_retailcrm_to_supabase";
import { run as runUpload } from "../../../upload_orders_to_retailcrm";

export const runtime = "nodejs";
export const maxDuration = 300;

const SCRIPT_LABELS = {
  upload_orders_to_retailcrm: "upload_orders_to_retailcrm.ts",
  sync_retailcrm_to_supabase: "sync_retailcrm_to_supabase.ts",
} as const;

type AllowedScriptName = keyof typeof SCRIPT_LABELS;

function isAllowedScriptName(value: unknown): value is AllowedScriptName {
  return typeof value === "string" && value in SCRIPT_LABELS;
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
    return NextResponse.json(
      { error: "Unsupported script requested." },
      { status: 400 },
    );
  }

  const label = SCRIPT_LABELS[scriptName];
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const logger = {
    log: (msg: string) => {
      stdoutLines.push(msg);
    },
    error: (msg: string) => {
      stderrLines.push(msg);
    },
  };

  try {
    const { ok } =
      scriptName === "sync_retailcrm_to_supabase"
        ? await runSync({}, logger)
        : await runUpload({}, logger);

    return NextResponse.json({
      ok,
      script: label,
      stdout: stdoutLines.join("\n"),
      stderr: stderrLines.join("\n"),
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        script: label,
        stdout: stdoutLines.join("\n"),
        stderr: stderrLines.join("\n"),
        message: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
