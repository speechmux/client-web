import { NextResponse } from "next/server";
import type { EngineListResponse, EngineOption } from "@/lib/engine-options";
import { FALLBACK_ENGINES } from "@/lib/engine-options";

interface InferenceEndpoint {
  id: string;
  healthy: boolean;
  engine_name?: string;
  model_size?: string;
  device?: string;
}

interface AdminPluginsResponse {
  inference: InferenceEndpoint[];
}

// No route-level `revalidate`: that would prerender this handler during `next build`,
// when Core is not running, and serve the resulting fallback list to the first
// visitor. The handler runs per request; only Core's answer is cached (30 s, below).
export async function GET(): Promise<NextResponse<EngineListResponse>> {
  // Default matches Core's http_port (8090). Override with CORE_ADMIN_URL in
  // docker-compose (e.g. http://core:8090) or local dev (.env.local).
  const adminUrl = process.env.CORE_ADMIN_URL ?? "http://localhost:8090";
  // `source` tells the page whether this is Core's real list or the built-in
  // fallback, so it can say so instead of presenting guesses as available engines.
  try {
    const response = await fetch(`${adminUrl}/admin/plugins`, {
      next: { revalidate: 30 }, // 30-second cache
    });
    if (!response.ok) {
      return NextResponse.json({ engines: FALLBACK_ENGINES, source: "unreachable" });
    }
    const data: AdminPluginsResponse = await response.json() as AdminPluginsResponse;
    // Only surface healthy endpoints — unhealthy ones would silently fall back
    // to a different engine, which is confusing for the user.
    const engines: EngineOption[] = data.inference
      .filter((ep) => ep.healthy)
      .map((ep) => {
        const parts = [ep.engine_name ?? ep.id];
        if (ep.model_size) parts.push(ep.model_size);
        if (ep.device) parts.push(ep.device);
        return { id: ep.id, label: parts.join(" · ") };
      });
    if (engines.length === 0) {
      return NextResponse.json({ engines: FALLBACK_ENGINES, source: "no_healthy_engines" });
    }
    return NextResponse.json({ engines, source: "core" });
  } catch {
    return NextResponse.json({ engines: FALLBACK_ENGINES, source: "unreachable" });
  }
}
