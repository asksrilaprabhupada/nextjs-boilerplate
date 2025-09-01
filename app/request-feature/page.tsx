"use client";
import { useState } from "react";

export default function RequestFeaturePage() {
  const [status, setStatus] = useState<"idle" | "ok" | "err" | "sending">("idle");
  const [form, setForm] = useState({ name: "", email: "", country: "", feature: "" });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("sending");
    const res = await fetch("/api/feature", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    setStatus(res.ok ? "ok" : "err");
    if (res.ok) setForm({ name: "", email: "", country: "", feature: "" });
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <div className="rounded-3xl bg-white p-6 shadow-sm">
        <h1 className="mb-2 text-2xl font-semibold text-slate-900">Request a Feature</h1>
        <p className="mb-6 text-sm text-slate-600">Suggest improvements. We’ll email you a copy of your request.</p>

        <form onSubmit={submit} className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label className="block text-sm font-medium">Name</label>
              <input className="mt-1 w-full rounded-xl border px-3 py-2" required
                value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}/>
            </div>
            <div>
              <label className="block text-sm font-medium">Country</label>
              <input className="mt-1 w-full rounded-xl border px-3 py-2" required
                value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })}/>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium">Email (for follow-up)</label>
            <input type="email" className="mt-1 w-full rounded-xl border px-3 py-2" required
              value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })}/>
          </div>

          <div>
            <label className="block text-sm font-medium">Describe the feature</label>
            <textarea className="mt-1 w-full rounded-2xl border px-3 py-3 min-h-32" required
              placeholder="What should it do? Why is it helpful?"
              value={form.feature} onChange={(e) => setForm({ ...form, feature: e.target.value })}/>
          </div>

          <button disabled={status === "sending"}
            className="inline-flex items-center justify-center rounded-full bg-orange-500 px-5 py-2 text-white shadow hover:bg-orange-600 disabled:opacity-50">
            {status === "sending" ? "Sending…" : "Submit"}
          </button>

          {status === "ok" && <p className="text-green-600">Thank you — we emailed you a copy.</p>}
          {status === "err" && <p className="text-red-600">Something failed. Please try again.</p>}
        </form>
      </div>
    </main>
  );
}
