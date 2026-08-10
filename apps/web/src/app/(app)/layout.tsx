"use client";

import { RequireAuth } from "@/components/auth";
import { Shell } from "@/components/shell";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequireAuth>
      <Shell>{children}</Shell>
    </RequireAuth>
  );
}
