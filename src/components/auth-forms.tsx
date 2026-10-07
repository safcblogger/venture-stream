"use client";

import { useActionState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { loginAction, registerAction } from "@/app/auth-actions";

export function LoginForm() {
  const [state, action, pending] = useActionState(loginAction, null);
  return (
    <form action={action} className="stack">
      <div className="field">
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" autoComplete="email" required autoFocus />
      </div>
      <div className="field">
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required />
      </div>
      {state?.error && <div className="alert error" role="alert">{state.error}</div>}
      <button className="btn primary" disabled={pending}>
        {pending && <Loader2 size={14} className="spin" />} Sign in
      </button>
      <p className="muted">
        New to Venture Stream? <Link href="/register">Create an account</Link>
      </p>
    </form>
  );
}

export function RegisterForm() {
  const [state, action, pending] = useActionState(registerAction, null);
  return (
    <form action={action} className="stack">
      <div className="field">
        <label htmlFor="name">Your name</label>
        <input id="name" name="name" autoComplete="name" required autoFocus />
      </div>
      <div className="field">
        <label htmlFor="workspaceName">Workspace name</label>
        <input id="workspaceName" name="workspaceName" placeholder="Your company or team" required />
      </div>
      <div className="field">
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" autoComplete="email" required />
      </div>
      <div className="field">
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" autoComplete="new-password" minLength={10} required />
        <span className="faint">At least 10 characters.</span>
      </div>
      {state?.error && <div className="alert error" role="alert">{state.error}</div>}
      <button className="btn primary" disabled={pending}>
        {pending && <Loader2 size={14} className="spin" />} Create account
      </button>
      <p className="muted">
        Already have an account? <Link href="/login">Sign in</Link>
      </p>
    </form>
  );
}
