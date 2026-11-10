import React, { useState } from "react";
import { Card, Button, Note, Field, inputClass, Spinner } from "./ui.jsx";
import { cx } from "../api.js";

export default function LoginCard({ waiting, authUrl, onStart, onPaste, busy, loginName }) {
  const [text, setText] = useState("");
  const [note, setNote] = useState({ tone: "idle", text: "" });

  function paste() {
    if (!text.trim()) {
      setNote({ tone: "err", text: "Paste the callback URL or the code first." });
      return;
    }
    setNote({ tone: "idle", text: "Completing sign-in..." });
    onPaste(text.trim(), (err, message) => {
      if (err) setNote({ tone: "err", text: err });
      else {
        setNote({ tone: "ok", text: message });
        setText("");
      }
    });
  }

  return (
    <Card title="Sign in" step="3" id="signin">
      <Button onClick={onStart} disabled={busy || waiting} className="w-full">
        {waiting ? <Spinner /> : null}
        {waiting ? "Waiting for sign-in..." : "Login and add account"}
      </Button>
      <p className="mt-1.5 text-[11px] text-slate-400">
        {loginName ? "will be saved as " + loginName : "name defaults to the username"}
      </p>

      {waiting && authUrl ? (
        <div className="mt-3 rounded-lg border border-dashed border-blue-400/40 bg-blue-500/[0.06] px-3 py-2.5">
          <p className="text-[11.5px] text-slate-300">
            Finish in the opened tab. The callback returns to this port.
          </p>
          <a
            className="mt-1 block break-all font-mono text-[10.5px] text-blue-300 hover:underline"
            href={authUrl}
            target="_blank"
            rel="noreferrer"
          >
            {authUrl}
          </a>
        </div>
      ) : null}

      <div className="my-4 h-px" style={{ background: "var(--hairline)" }} />

      <Field
        label="Manual sign-in"
        hint="If the login tab ends on an /auth-callback URL, paste it here - or just the code."
      >
        <textarea
          className={cx(inputClass, "scroll-thin h-[64px] resize-y font-mono text-[11px]")}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="http://127.0.0.1:8787/auth-callback?code=...&state=..."
          aria-label="Callback URL or code"
        />
      </Field>
      <div className="mt-2 flex items-center gap-2">
        <Button size="sm" onClick={paste} disabled={busy}>
          Complete sign-in
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setText("");
            setNote({ tone: "idle", text: "" });
          }}
        >
          Clear
        </Button>
      </div>
      <Note tone={note.tone}>{note.text}</Note>
    </Card>
  );
}
