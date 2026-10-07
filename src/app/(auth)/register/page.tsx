import { Radar } from "lucide-react";
import { redirectIfSignedIn } from "@/app/auth-actions";
import { RegisterForm } from "@/components/auth-forms";
import { env } from "@/lib/env";

export const metadata = { title: "Create account" };
export const dynamic = "force-dynamic";

export default async function RegisterPage() {
  await redirectIfSignedIn();
  const closed = env().ALLOW_REGISTRATION === "false";
  return (
    <div className="auth">
      <div className="auth-card stack">
        <div className="brand">
          <span className="brand-mark"><Radar size={14} /></span> Venture Stream
        </div>
        <div className="card card-body">
          <h1 style={{ marginBottom: 4 }}>Create your account</h1>
          <p className="muted" style={{ marginBottom: 12 }}>You will get your own workspace. Invite teammates afterwards.</p>
          {closed ? <div className="alert info">Sign-up is closed. Ask a workspace owner to add you.</div> : <RegisterForm />}
        </div>
      </div>
    </div>
  );
}
