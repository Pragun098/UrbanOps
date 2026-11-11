"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { errorMessage } from "@/lib/api";
import { homeFor, useAuth } from "@/lib/auth";

type Mode = "login" | "register";

export default function LoginPage() {
  const { status, user, login, register } = useAuth();
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("login");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Already signed in → go to the right home page.
  useEffect(() => {
    if (status === "authenticated" && user) router.replace(homeFor(user.role));
  }, [status, user, router]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") || "");
    const password = String(form.get("password") || "");
    setBusy(true);
    setError(null);
    try {
      const signedIn =
        mode === "login" ? await login(email, password) : await register(String(form.get("name") || ""), email, password);
      router.replace(homeFor(signedIn.role));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="report-page">
      <div className="report-container auth-container">
        <div className="report-header">
          <p className="eyebrow">URBANOPS COMMAND CENTER</p>
          <h1>{mode === "login" ? "Sign in" : "Create a citizen account"}</h1>
          <p>
            {mode === "login"
              ? "Dispatchers and admins see the live command center. Citizens can report issues and track them."
              : "Report potholes, leaks and hazards, and follow their progress until they're fixed."}
          </p>
        </div>

        <div className="tabs" role="tablist">
          <button type="button" role="tab" aria-selected={mode === "login"} className={mode === "login" ? "tab active" : "tab"} onClick={() => { setMode("login"); setError(null); }}>
            Sign in
          </button>
          <button type="button" role="tab" aria-selected={mode === "register"} className={mode === "register" ? "tab active" : "tab"} onClick={() => { setMode("register"); setError(null); }}>
            Register
          </button>
        </div>

        <form className="report-form" onSubmit={handleSubmit}>
          {error && <div className="alert error">{error}</div>}

          {mode === "register" && (
            <div className="form-group">
              <label htmlFor="name">Full name</label>
              <input id="name" name="name" type="text" autoComplete="name" required maxLength={100} />
            </div>
          )}

          <div className="form-group">
            <label htmlFor="email">Email</label>
            <input id="email" name="email" type="email" autoComplete="email" required />
          </div>

          <div className="form-group">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              minLength={mode === "register" ? 8 : undefined}
              maxLength={72}
              required
            />
            {mode === "register" && <span className="field-hint">At least 8 characters.</span>}
          </div>

          <button type="submit" className="submit-button" disabled={busy}>
            {busy ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
          </button>
        </form>

        {process.env.NODE_ENV !== "production" && (
          <div className="dev-hint mono">
            Dev accounts (npm run seed): dispatcher@urbanops.local / dispatch12345 · admin@urbanops.local / admin12345
          </div>
        )}
      </div>
    </main>
  );
}
