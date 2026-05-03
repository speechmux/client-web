import { NextResponse } from "next/server";
import type { EngineOption } from "@/lib/engine-options";
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

export const revalidate = 30; // 30-second cache

export async function GET(): Promise<NextResponse<EngineOption[]>> {
  // Default matches Core's http_port (8090). Override with CORE_ADMIN_URL in
  // docker-compose (e.g. http://core:8090) or local dev (.env.local).
  const adminUrl = process.env.CORE_ADMIN_URL ?? "http://localhost:8090";
  try {
    const response = await fetch(`${adminUrl}/admin/plugins`, {
      next: { revalidate: 30 },
    });
    if (!response.ok) {
      return NextResponse.json(FALLBACK_ENGINES);
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
      return NextResponse.json(FALLBACK_ENGINES);
    }
    return NextResponse.json(engines);
  } catch {
    return NextResponse.json(FALLBACK_ENGINES);
  }
}
