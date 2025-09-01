"use client";
import { useState } from "react";

export default function ContactPage() {
  const [status, setStatus] = useState<"idle" | "ok" | "err" | "sending">("idle");
  const [form, setForm] = useState({ name: "", email: "", subject: "", message: "" });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("sending");
    const res = await fetch("/api/contact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    setStatus(res.ok ? "ok" : "err");
    if (res.ok) setForm({ name: "", email: "", subject: "", message: "" });
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <div className="rounded-3xl bg-white p-6 shadow-sm">
        <h1 className="mb-2 text-2xl font-semibold text-slate-900">Contact Me</h1>
        <p className="mb-6 text-sm text-slate-600">Your message will be delivered privately.</p>

        <form onSubmit={submit} className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label className="block text-sm font-medium">Name</label>
              <input className="mt-1 w-full rounded-xl border px-3 py-2" required
                value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}/>
            </div>
            <div>
              <label className="block text-sm font-medium">Email</label>
              <input type="email" className="mt-1 w-full rounded-xl border px-3 py-2" required
                value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })}/>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium">Subject</label>
            <input className="mt-1 w-full rounded-xl border px-3 py-2" required
              value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })}/>
          </div>

          <div>
            <label className="block text-sm font-medium">Message</label>
            <textarea className="mt-1 w-full rounded-2xl border px-3 py-3 min-h-32" required
              value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })}/>
          </div>

          <button disabled={status === "sending"}
            className="inline-flex items-center justify-center rounded-full bg-orange-500 px-5 py-2 text-white shadow hover:bg-orange-600 disabled:opacity-50">
            {status === "sending" ? "Sending…" : "Send"}
          </button>

          {status === "ok" && <p className="text-green-600">Sent. We’ll reply to your email.</p>}
          {status === "err" && <p className="text-red-600">Could not send. Please try again.</p>}
        </form>
      </div>
    </main>
  );
}
