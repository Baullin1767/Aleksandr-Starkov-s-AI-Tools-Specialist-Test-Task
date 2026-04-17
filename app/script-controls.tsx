"use client";

import { startTransition, useState } from "react";

type ScriptStatus = {
  type: "idle" | "running" | "success" | "error";
  title: string;
  output: string;
};

const initialStatus: ScriptStatus = {
  type: "idle",
  title: "Script controls",
  output: "Run RetailCRM upload or Supabase sync directly from the dashboard.",
};

type ScriptName = "upload_orders_to_retailcrm" | "sync_retailcrm_to_supabase";

async function runScript(script: ScriptName): Promise<ScriptStatus> {
  const response = await fetch("/api/run-script", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ script }),
  });

  const data = (await response.json()) as {
    ok?: boolean;
    script?: string;
    stdout?: string;
    stderr?: string;
    message?: string;
    error?: string;
  };

  const output = [data.stdout, data.stderr, data.message, data.error].filter(Boolean).join("\n\n");
  const title = data.script ? `${data.script} finished` : "Script request completed";

  if (!response.ok || !data.ok) {
    return {
      type: "error",
      title,
      output: output || "The script failed without returning output.",
    };
  }

  return {
    type: "success",
    title,
    output: output || "The script completed without console output.",
  };
}

export function ScriptControls() {
  const [status, setStatus] = useState<ScriptStatus>(initialStatus);
  const [runningScript, setRunningScript] = useState<ScriptName | null>(null);

  function handleRun(script: ScriptName) {
    setRunningScript(script);
    setStatus({
      type: "running",
      title: "Script is running",
      output: "Please wait while the server executes the selected Python script.",
    });

    startTransition(async () => {
      const nextStatus = await runScript(script);
      setStatus(nextStatus);
      setRunningScript(null);
    });
  }

  return (
    <section className="script-controls-panel">
      <div className="script-controls-panel__copy">
        <p className="eyebrow">Operations</p>
        <h2>Run integration scripts</h2>
        <p className="script-controls-panel__text">
          Use these buttons to launch the RetailCRM uploader or the RetailCRM to Supabase sync
          without leaving the dashboard.
        </p>
      </div>

      <div className="script-controls-panel__actions">
        <button
          type="button"
          className="script-action-button"
          onClick={() => handleRun("upload_orders_to_retailcrm")}
          disabled={runningScript !== null}
        >
          {runningScript === "upload_orders_to_retailcrm" ? "Uploading..." : "Run upload script"}
        </button>
        <button
          type="button"
          className="script-action-button script-action-button--secondary"
          onClick={() => handleRun("sync_retailcrm_to_supabase")}
          disabled={runningScript !== null}
        >
          {runningScript === "sync_retailcrm_to_supabase" ? "Syncing..." : "Run sync script"}
        </button>
      </div>

      <div
        className={`script-status script-status--${status.type}`}
        aria-live="polite"
      >
        <strong>{status.title}</strong>
        <pre>{status.output}</pre>
      </div>
    </section>
  );
}
