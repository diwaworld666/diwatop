import { db } from "@/db";
import { games, posts, categories, tags, pages } from "@/db/schema";
import { and, asc, count, eq, gt, or, sql, type SQLWrapper } from "drizzle-orm";
import { configuredSiteUrl, escapeXml } from "@/lib/util";
import { getSettings } from "@/lib/settings";

export const SITEMAP_URL_LIMIT = (() => {
  const raw = Number.parseInt(process.env.SITEMAP_URL_LIMIT || "50000", 10);
  if (!Number.isFinite(raw) || raw < 1) return 50000;
  return Math.min(raw, 50000);
})();

export type SitemapType = "games" | "posts" | "categories" | "tags" | "pages";

export const SITEMAP_TYPES: SitemapType[] = [
  "games",
  "posts",
  "categories",
  "tags",
  "pages",
];

const STATIC_URLS = [
  { path: "/", priority: "1.0", freq: "daily" },
  { path: "/games", priority: "0.9", freq: "daily" },
  { path: "/blog", priority: "0.8", freq: "daily" },
  { path: "/contact", priority: "0.4", freq: "monthly" },
  { path: "/request", priority: "0.4", freq: "monthly" },
] as const;

type Row = {
  slug: string;
  updatedAt?: Date | null;
  canonicalUrl?: string | null;
};

function escapePathSegment(slug: string) {
  return encodeURIComponent(slug);
}

export function expectedPath(type: SitemapType, slug: string) {
  const safeSlug = escapePathSegment(slug);
  switch (type) {
    case "games": return `/game/${safeSlug}`;
    case "posts": return `/blog/${safeSlug}`;
    case "categories": return `/category/${safeSlug}`;
    case "tags": return `/tag/${safeSlug}`;
    case "pages": return `/page/${safeSlug}`;
  }
  throw new Error(`Unsupported sitemap type: ${type}`);
}

function canonicalCondition(
  column: SQLWrapper,
  slugColumn: SQLWrapper,
  prefix: string,
  base: string,
) {
  // Custom canonicals that point elsewhere are excluded. Self-canonicals can
  // be stored as the normal relative path or the configured absolute URL.
  return or(
    eq(column, ""),
    sql`${column} = ${prefix} || ${slugColumn}`,
    sql`${column} = ${base} || ${prefix} || ${slugColumn}`,
  );
}

function isSelfCanonical(canonicalUrl: string | null | undefined, base: string, path: string) {
  const value = String(canonicalUrl || "").trim();
  if (!value) return true;
  return value === path || value === `${base}${path}`;
}

function renderUrl(
  loc: string,
  lastmod?: Date | string | null,
  priority = "0.7",
  freq = "weekly",
) {
  return `  <url>
    <loc>${escapeXml(loc)}</loc>
    ${lastmod ? `<lastmod>${new Date(lastmod).toISOString()}</lastmod>` : ""}
    <changefreq>${freq}</changefreq>
    <priority>${priority}</priority>
  </url>`;
}

export function renderUrlset(items: string[]) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${items.join("\n")}
</urlset>`;
}

export function renderSitemapIndex(locs: string[]) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${locs.map((loc) => `  <sitemap>
    <loc>${escapeXml(loc)}</loc>
  </sitemap>`).join("\n")}
</sitemapindex>`;
}

export async function getSitemapBase() {
  return configuredSiteUrl(await getSettings());
}

async function getStaticSitemapItems(base: string) {
  const settings = await getSettings();
  const homepageCanonical = String(settings.seo.homepage.canonical || "").trim();
  const homepageSelfCanonical =
    !homepageCanonical ||
    homepageCanonical === "/" ||
    homepageCanonical === `${base}/`;

  return STATIC_URLS
    .filter((item) => item.path !== "/" || (
      !settings.seo.homepage.noIndex &&
      homepageSelfCanonical
    ));
}

export async function getStaticSitemapUrlCount(base: string) {
  return (await getStaticSitemapItems(base)).length;
}

async function getSitemapCount(type: SitemapType, base: string) {
  switch (type) {
    case "games":
      return Number((await db.select({ value: count() }).from(games).where(and(
        eq(games.status, "published"),
        eq(games.noIndex, false),
        gt(games.slug, ""),
        canonicalCondition(games.canonicalUrl, games.slug, "/game/", base),
      )))[0]?.value || 0);
    case "posts":
      return Number((await db.select({ value: count() }).from(posts).where(and(
        eq(posts.status, "published"),
        eq(posts.noIndex, false),
        gt(posts.slug, ""),
        canonicalCondition(posts.canonicalUrl, posts.slug, "/blog/", base),
      )))[0]?.value || 0);
    case "categories":
      return Number((await db.select({ value: count() }).from(categories).where(and(
        eq(categories.noIndex, false),
        gt(categories.slug, ""),
        canonicalCondition(categories.canonicalUrl, categories.slug, "/category/", base),
      )))[0]?.value || 0);
    case "tags":
      return Number((await db.select({ value: count() }).from(tags).where(and(
        eq(tags.noIndex, false),
        gt(tags.slug, ""),
        canonicalCondition(tags.canonicalUrl, tags.slug, "/tag/", base),
      )))[0]?.value || 0);
    case "pages":
      return Number((await db.select({ value: count() }).from(pages).where(and(
        eq(pages.noIndex, false),
        gt(pages.slug, ""),
        canonicalCondition(pages.canonicalUrl, pages.slug, "/page/", base),
      )))[0]?.value || 0);
  }
  throw new Error(`Unsupported sitemap type: ${type}`);
}

export async function getSitemapCounts(base: string): Promise<Record<SitemapType, number>> {
  const results = await Promise.allSettled(
    SITEMAP_TYPES.map((type) => getSitemapCount(type, base))
  );
  const counts = {} as Record<SitemapType, number>;

  results.forEach((result, index) => {
    const type = SITEMAP_TYPES[index];
    if (result.status === "fulfilled") {
      counts[type] = result.value;
    } else {
      counts[type] = 0;
      console.error(`[sitemap] ${type} count query failed:`, result.reason);
    }
  });

  return counts;
}

export async function getSitemapTypeCount(type: SitemapType, base: string) {
  try {
    return await getSitemapCount(type, base);
  } catch (error) {
    console.error(`[sitemap] ${type} count query failed:`, error);
    return 0;
  }
}

export async function getSitemapRows(
  type: SitemapType,
  base: string,
  offset: number,
  limit: number,
): Promise<Row[]> {
  switch (type) {
    case "games":
      return db.select({
        slug: games.slug,
        updatedAt: games.updatedAt,
        canonicalUrl: games.canonicalUrl,
      }).from(games)
        .where(and(
          eq(games.status, "published"),
          eq(games.noIndex, false),
          gt(games.slug, ""),
          canonicalCondition(games.canonicalUrl, games.slug, "/game/", base),
        ))
        .orderBy(asc(games.id))
        .limit(limit)
        .offset(offset);
    case "posts":
      return db.select({
        slug: posts.slug,
        updatedAt: posts.updatedAt,
        canonicalUrl: posts.canonicalUrl,
      }).from(posts)
        .where(and(
          eq(posts.status, "published"),
          eq(posts.noIndex, false),
          gt(posts.slug, ""),
          canonicalCondition(posts.canonicalUrl, posts.slug, "/blog/", base),
        ))
        .orderBy(asc(posts.id))
        .limit(limit)
        .offset(offset);
    case "categories":
      return db.select({
        slug: categories.slug,
        canonicalUrl: categories.canonicalUrl,
      }).from(categories)
        .where(and(
          eq(categories.noIndex, false),
          gt(categories.slug, ""),
          canonicalCondition(categories.canonicalUrl, categories.slug, "/category/", base),
        ))
        .orderBy(asc(categories.id))
        .limit(limit)
        .offset(offset);
    case "tags":
      return db.select({
        slug: tags.slug,
        canonicalUrl: tags.canonicalUrl,
      }).from(tags)
        .where(and(
          eq(tags.noIndex, false),
          gt(tags.slug, ""),
          canonicalCondition(tags.canonicalUrl, tags.slug, "/tag/", base),
        ))
        .orderBy(asc(tags.id))
        .limit(limit)
        .offset(offset);
    case "pages":
      return db.select({
        slug: pages.slug,
        updatedAt: pages.updatedAt,
        canonicalUrl: pages.canonicalUrl,
      }).from(pages)
        .where(and(
          eq(pages.noIndex, false),
          gt(pages.slug, ""),
          canonicalCondition(pages.canonicalUrl, pages.slug, "/page/", base),
        ))
        .orderBy(asc(pages.id))
        .limit(limit)
        .offset(offset);
  }
  throw new Error(`Unsupported sitemap type: ${type}`);
}

function renderRows(type: SitemapType, base: string, rows: Row[]) {
  const priority = type === "games" ? "0.9" :
    type === "posts" ? "0.8" :
    type === "categories" ? "0.8" :
    type === "tags" ? "0.6" : "0.5";
  const freq = type === "games" || type === "categories" ? "daily" :
    type === "posts" ? "weekly" :
    type === "tags" ? "weekly" : "monthly";

  return rows
    .map((row) => {
      const path = expectedPath(type, row.slug);
      if (!isSelfCanonical(row.canonicalUrl, base, path)) return null;
      return renderUrl(`${base}${path}`, row.updatedAt, priority, freq);
    })
    .filter((item): item is string => Boolean(item));
}

export async function renderTypeSitemap(
  type: SitemapType,
  base: string,
  page: number,
) {
  if (!Number.isInteger(page) || page < 1) throw new Error("Invalid sitemap page");
  const offset = (page - 1) * SITEMAP_URL_LIMIT;
  const rows = await getSitemapRows(type, base, offset, SITEMAP_URL_LIMIT);
  return renderUrlset(renderRows(type, base, rows).slice(0, SITEMAP_URL_LIMIT));
}

export async function renderAllSitemap(base: string) {
  const staticUrls = await getStaticSitemapItems(base);
  const staticItems = staticUrls.map((item) =>
    renderUrl(`${base}${item.path}`, undefined, item.priority, item.freq)
  );
  const items = [...staticItems];

  if (items.length >= SITEMAP_URL_LIMIT) return renderUrlset(items.slice(0, SITEMAP_URL_LIMIT));

  for (const type of SITEMAP_TYPES) {
    const available = SITEMAP_URL_LIMIT - items.length;
    if (available <= 0) break;
    try {
      const rows = await getSitemapRows(type, base, 0, available);
      items.push(...renderRows(type, base, rows));
    } catch (error) {
      // One optional content table should not prevent the core sitemap from
      // being served. That content type will return on the next regeneration.
      console.error(`[sitemap] ${type} query failed:`, error);
    }
  }

  return renderUrlset(items.slice(0, SITEMAP_URL_LIMIT));
}

export function sitemapChunkCount(count: number) {
  return Math.ceil(count / SITEMAP_URL_LIMIT);
}

export { STATIC_URLS };
