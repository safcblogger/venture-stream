import { Radar } from "lucide-react";
import { redirectIfSignedIn } from "@/app/auth-actions";
import { LoginForm } from "@/components/auth-forms";

export const metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

export default async function LoginPage() {
  await redirectIfSignedIn();
  return (
    <div className="auth">
      <div className="auth-card stack">
        <div className="brand">
          <span className="brand-mark"><Radar size={14} /></span> Venture Stream
        </div>
        <div className="card card-body">
          <h1 style={{ marginBottom: 12 }}>Sign in</h1>
          <LoginForm />
        </div>
      </div>
    </div>
  );
}
