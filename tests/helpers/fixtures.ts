import { randomUUID } from "node:crypto";
import { registerAccount } from "@/lib/services/accounts";
import { createProspect } from "@/lib/services/prospects";
import type { Scope } from "@/lib/services/common";

/** Creates an isolated user + workspace through the real registration path. Test-only. */
export async function newWorkspace(label = "t"): Promise<Scope & { email: string }> {
  const email = `${label}-${randomUUID()}@example.test`;
  const { user, workspace } = await registerAccount({ name: "Test User", email, password: "correct horse battery", workspaceName: `${label} workspace` });
  return { workspaceId: workspace.id, userId: user.id, email };
}

export async function newProspect(scope: Scope, name: string, domain = `${name.toLowerCase().replace(/[^a-z]/g, "")}-${randomUUID().slice(0, 6)}.test.co.uk`) {
  return createProspect(scope, { name, website: domain });
}
