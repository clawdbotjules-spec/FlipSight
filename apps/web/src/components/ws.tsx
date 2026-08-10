"use client";

/**
 * Realtime provider: one native WebSocket per session, auto-reconnect with
 * exponential backoff, and a subscriber registry for `deal.new` pushes. Also
 * tracks the last measured publish→client latency so the topbar can prove the
 * <1s alert budget live.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { wsUrl } from "@/lib/api";
import type { WsDealMessage } from "@/lib/types";
import { useAuth } from "./auth";

type DealListener = (msg: WsDealMessage, receivedAt: number) => void;

interface WsState {
  status: "off" | "connecting" | "open";
  lastLatencyMs: number | null;
  subscribe: (fn: DealListener) => () => void;
}

const WsContext = createContext<WsState | null>(null);

export function WsProvider({ children }: { children: React.ReactNode }) {
  const { token } = useAuth();
  const [status, setStatus] = useState<WsState["status"]>("off");
  const [lastLatencyMs, setLastLatencyMs] = useState<number | null>(null);
  const listeners = useRef(new Set<DealListener>());
  const retryRef = useRef(0);

  useEffect(() => {
    if (!token) {
      setStatus("off");
      return;
    }
    let ws: WebSocket | null = null;
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (closed) return;
      setStatus("connecting");
      ws = new WebSocket(wsUrl(token));
      ws.onopen = () => {
        retryRef.current = 0;
        setStatus("open");
      };
      ws.onmessage = (event) => {
        const receivedAt = Date.now();
        try {
          const msg = JSON.parse(event.data as string) as WsDealMessage | { type: string };
          if (msg.type === "deal.new") {
            const dealMsg = msg as WsDealMessage;
            setLastLatencyMs(Math.max(0, receivedAt - dealMsg.publishedAt));
            for (const fn of listeners.current) fn(dealMsg, receivedAt);
          }
        } catch {
          // non-JSON frame — ignore
        }
      };
      ws.onclose = (event) => {
        setStatus("off");
        if (closed || event.code === 4401) return; // bad token: stay closed, auth layer handles it
        const delay = Math.min(30_000, 1000 * 2 ** retryRef.current) + Math.random() * 500;
        retryRef.current += 1;
        timer = setTimeout(connect, delay);
      };
      ws.onerror = () => ws?.close();
    };

    connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }, [token]);

  const subscribe = useCallback((fn: DealListener) => {
    listeners.current.add(fn);
    return () => listeners.current.delete(fn);
  }, []);

  const value = useMemo(() => ({ status, lastLatencyMs, subscribe }), [status, lastLatencyMs, subscribe]);
  return <WsContext.Provider value={value}>{children}</WsContext.Provider>;
}

export function useWs(): WsState {
  const ctx = useContext(WsContext);
  if (!ctx) throw new Error("useWs outside WsProvider");
  return ctx;
}
