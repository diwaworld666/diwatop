```ts
import {
  getSitemapBase,
  getSitemapCounts,
  getStaticSitemapUrlCount,
  renderAllSitemap,
  renderSitemapIndex,
  sitemapChunkCount,
  SITEMAP_TYPES,
  SITEMAP_URL_LIMIT,
} from "@/lib/sitemap";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const base = await getSitemapBase();
    const counts = await getSitemapCounts(base);

    const total =
      Object.values(counts).reduce((sum, value) => sum + value, 0) +
      (await getStaticSitemapUrlCount(base));

    if (total <= SITEMAP_URL_LIMIT) {
      return new Response(await renderAllSitemap(base), {
        headers: {
          "content-type": "application/xml; charset=utf-8",
          "cache-control": "public, max-age=3600",
        },
      });
    }

    const sitemapUrls = SITEMAP_TYPES.flatMap((type) => {
      const count = counts[type];

      return Array.from(
        { length: sitemapChunkCount(count) },
        (_, i) => `${base}/sitemap-${type}-${i + 1}.xml`
      );
    });

    return new Response(renderSitemapIndex(sitemapUrls), {
      headers: {
        "content-type": "application/xml; charset=utf-8",
        "cache-control": "public, max-age=3600",
      },
    });
  } catch (error) {
    // Keep the sitemap endpoint available during temporary errors.
    console.error("[sitemap] failed to generate sitemap:", error);

    try {
      const base = await getSitemapBase();

      return new Response(await renderAllSitemap(base), {
        headers: {
          "content-type": "application/xml; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    } catch (fallbackError) {
      console.error("[sitemap] fallback generation failed:", fallbackError);

      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>`,
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
}
```
