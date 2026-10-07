import { LogOut } from "lucide-react";
import { logoutAction } from "@/app/auth-actions";
import { Assistant } from "@/components/assistant";
import { MenuButton, Sidebar } from "@/components/shell";
import { requireContext } from "@/lib/auth";
import { taskCounts } from "@/lib/services/tasks";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireContext();
  const counts = await taskCounts({ workspaceId: ctx.workspace.id, userId: ctx.user.id });
  return (
    <div className="app">
      <Sidebar
        overdue={counts.overdue}
        footer={
          <form action={logoutAction}>
            <button className="nav-link" style={{ width: "100%", background: "none", border: 0, font: "inherit", cursor: "pointer" }}>
              <LogOut size={15} /> Sign out
            </button>
          </form>
        }
      />
      <div className="main">
        <header className="topbar">
          <MenuButton />
          <strong className="truncate">{ctx.workspace.name}</strong>
          <span className="grow" />
          <span className="muted hide-sm">{ctx.user.name}</span>
        </header>
        <main className="page">{children}</main>
      </div>
      <Assistant />
    </div>
  );
}
