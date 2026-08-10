"use client";

/**
 * App chrome: glass sidebar on desktop, bottom tab bar on mobile, and a thin
 * topbar with the live WebSocket status + last measured alert latency.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "./auth";
import { useWs } from "./ws";
import { ChartIcon, LogoMark, NodesIcon, PulseIcon, RadarIcon, SparkIcon } from "./icons";

const NAV = [
  { href: "/", label: "Live Feed", icon: RadarIcon },
  { href: "/pnl", label: "P&L", icon: ChartIcon },
  { href: "/sources", label: "Sources & Rules", icon: NodesIcon },
  { href: "/assistant", label: "Assistant", icon: SparkIcon },
  { href: "/status", label: "System", icon: PulseIcon },
] as const;

function WsBadge() {
  const { status, lastLatencyMs } = useWs();
  const color = status === "open" ? "bg-profit" : status === "connecting" ? "bg-warn" : "bg-loss";
  return (
    <div className="flex items-center gap-2 text-[11px] text-muted">
      <span className={`pulse-dot inline-block h-1.5 w-1.5 rounded-full ${color}`} />
      <span className="hidden sm:inline">
        {status === "open" ? "realtime link" : status === "connecting" ? "linking…" : "offline"}
      </span>
      {lastLatencyMs != null && status === "open" && (
        <span className="num text-acc">{lastLatencyMs}ms</span>
      )}
    </div>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { me, logout } = useAuth();

  return (
    <div className="flex min-h-dvh">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-56 flex-col border-r border-line bg-panel/60 backdrop-blur-xl md:flex">
        <div className="flex items-center gap-2.5 px-5 pt-5 pb-6">
          <span className="grid h-8 w-8 place-items-center rounded-lg border border-acc/30 bg-acc/10 text-acc">
            <LogoMark width={17} height={17} />
          </span>
          <div>
            <div className="text-[15px] font-semibold tracking-tight">FlipSight</div>
            <div className="text-[10px] tracking-[0.2em] text-faint uppercase">mission control</div>
          </div>
        </div>
        <nav className="flex-1 space-y-1 px-3">
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = pathname === href;
            return (
              <Link
                key={href}
                href={href}
                className={`group relative flex items-center gap-3 rounded-md px-3 py-2 text-[13px] font-medium transition-colors ${
                  active ? "bg-acc/10 text-acc" : "text-muted hover:bg-raise/80 hover:text-ink"
                }`}
              >
                {active && (
                  <span className="absolute top-1/2 left-0 h-4 w-0.5 -translate-y-1/2 rounded-full bg-acc shadow-[0_0_8px_rgba(34,211,238,0.8)]" />
                )}
                <Icon className={active ? "text-acc" : "text-faint group-hover:text-muted"} />
                {label}
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-line px-5 py-4">
          <div className="truncate text-xs text-muted">{me?.user.email}</div>
          <div className="mt-0.5 flex items-center justify-between">
            <span className="truncate text-[11px] text-faint">{me?.org.name}</span>
            <button onClick={logout} className="cursor-pointer text-[11px] text-faint transition-colors hover:text-loss">
              log out
            </button>
          </div>
        </div>
      </aside>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col md:pl-56">
        <header className="sticky top-0 z-20 flex h-12 items-center justify-between border-b border-line bg-bg/75 px-4 backdrop-blur-lg md:px-6">
          <div className="flex items-center gap-2.5 md:hidden">
            <span className="grid h-6 w-6 place-items-center rounded-md border border-acc/30 bg-acc/10 text-acc">
              <LogoMark width={13} height={13} />
            </span>
            <span className="text-sm font-semibold">FlipSight</span>
          </div>
          <div className="hidden text-[11px] tracking-[0.18em] text-faint uppercase md:block">
            {NAV.find((n) => n.href === pathname)?.label ?? ""}
          </div>
          <WsBadge />
        </header>

        <main className="min-w-0 flex-1 px-4 py-5 pb-20 md:px-6 md:pb-8">{children}</main>
      </div>

      {/* Mobile bottom tabs */}
      <nav className="fixed inset-x-0 bottom-0 z-30 flex border-t border-line bg-panel/85 backdrop-blur-xl md:hidden">
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = pathname === href;
          return (
            <Link
              key={href}
              href={href}
              className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-[9px] font-medium ${
                active ? "text-acc" : "text-faint"
              }`}
            >
              <Icon width={19} height={19} />
              {label.split(" ")[0]}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
