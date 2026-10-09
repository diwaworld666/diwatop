import {
  getSitemapBase,
  getSitemapTypeCount,
  renderTypeSitemap,
  sitemapChunkCount,
  SITEMAP_TYPES,
  SITEMAP_URL_LIMIT,
  type SitemapType,
} from "@/lib/sitemap";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function parseSitemapPath(path: string) {
  const match = /^sitemap-(games|posts|categories|tags|pages)-(\d+)\.xml$/.exec(path);
  if (!match) return null;

  const type = match[1] as SitemapType;
  const page = Number.parseInt(match[2], 10);
  if (!Number.isSafeInteger(page) || page < 1) return null;

  return { type, page };
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ sitemapPath?: string[] }> },
) {
  const params = await context.params;
  const path = params.sitemapPath?.join("/") || "";
  const parsed = parseSitemapPath(path);

  if (!parsed) {
    return new Response("Not Found", { status: 404 });
  }

  try {
    const base = await getSitemapBase();
    const count = await getSitemapTypeCount(parsed.type, base);
    const maxPage = sitemapChunkCount(count);

    if (parsed.page > maxPage || !SITEMAP_TYPES.includes(parsed.type)) {
      return new Response("Not Found", { status: 404 });
    }

    return new Response(
      await renderTypeSitemap(parsed.type, base, parsed.page),
      {
        headers: {
          "content-type": "application/xml; charset=utf-8",
          "cache-control": "public, max-age=3600",
        },
      }
    );
  } catch (error) {
    console.error(`[sitemap] failed to generate ${path}:`, error);
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>`,
      {
        status: 503,
        headers: {
          "content-type": "application/xml; charset=utf-8",
          "cache-control": "no-store",
        },
      }
    );
  }
}
