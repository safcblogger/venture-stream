import { safeFetchText } from "@/lib/net/safe-fetch";

/** A single observation made directly from a company's own website. */
export interface Observation {
  key: string;
  label: string;
  value: string;
}

export interface SiteInspection {
  reachable: boolean;
  finalUrl: string | null;
  platform: string | null;
  technologies: string[];
  observations: Observation[];
}

const PLATFORMS: { name: string; ecommerce: boolean; tests: RegExp[] }[] = [
  { name: "Shopify", ecommerce: true, tests: [/cdn\.shopify\.com/i, /Shopify\.theme/i, /myshopify\.com/i] },
  { name: "WooCommerce", ecommerce: true, tests: [/wp-content\/plugins\/woocommerce/i, /woocommerce/i] },
  { name: "Magento", ecommerce: true, tests: [/Magento_/i, /\/static\/version\d+/i, /mage\/cookies/i] },
  { name: "BigCommerce", ecommerce: true, tests: [/cdn\d*\.bigcommerce\.com/i, /bigcommerce/i] },
  { name: "PrestaShop", ecommerce: true, tests: [/prestashop/i] },
  { name: "Salesforce Commerce Cloud", ecommerce: true, tests: [/demandware\.(net|static)/i] },
  { name: "Shopware", ecommerce: true, tests: [/shopware/i] },
  { name: "Squarespace", ecommerce: false, tests: [/static1\.squarespace\.com/i, /squarespace-cdn/i] },
  { name: "Wix", ecommerce: false, tests: [/static\.wixstatic\.com/i, /wix\.com\/website/i] },
  { name: "WordPress", ecommerce: false, tests: [/wp-content\//i, /wp-includes\//i] },
  { name: "Webflow", ecommerce: false, tests: [/assets\.website-files\.com/i, /webflow\.js/i] },
];

const TECH: { name: string; test: RegExp }[] = [
  { name: "Google Tag Manager", test: /googletagmanager\.com\/gtm\.js|GTM-[A-Z0-9]+/ },
  { name: "Google Analytics 4", test: /gtag\/js\?id=G-|['"]G-[A-Z0-9]{6,}['"]/ },
  { name: "Universal Analytics", test: /UA-\d{4,}-\d+/ },
  { name: "Meta Pixel", test: /connect\.facebook\.net\/.*fbevents\.js|fbq\(/ },
  { name: "Klaviyo", test: /klaviyo\.com/i },
  { name: "Yotpo", test: /yotpo\.com/i },
  { name: "Trustpilot widget", test: /widget\.trustpilot\.com/i },
  { name: "Cloudflare", test: /cdnjs\.cloudflare\.com|cdn-cgi\//i },
  { name: "React", test: /react(\.production|-dom)|__NEXT_DATA__/i },
  { name: "Hotjar", test: /static\.hotjar\.com/i },
];

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i"));
  return m ? (m[2] ?? m[3] ?? "").trim() : null;
}

function metaContent(html: string, key: "name" | "property", value: string): string | null {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if (attr(tag, key)?.toLowerCase() === value) return attr(tag, "content");
  }
  return null;
}

/** Pure analysis of one HTML document. Everything returned is directly observed in the markup. */
export function analyseHtml(html: string, url: string): Omit<SiteInspection, "reachable" | "finalUrl"> {
  const obs: Observation[] = [];
  const add = (key: string, label: string, value: string) => obs.push({ key, label, value });

  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim();
  add("page_title", "Homepage title", title ? `"${title.slice(0, 160)}" (${title.length} characters)` : "Missing");

  const description = metaContent(html, "name", "description");
  add("meta_description", "Meta description", description ? `Present (${description.length} characters)` : "Missing on the homepage");

  const h1 = (html.match(/<h1\b/gi) ?? []).length;
  add("h1_count", "H1 headings on homepage", h1 === 0 ? "None found" : String(h1));

  const canonical = (html.match(/<link\b[^>]*>/gi) ?? []).map((t) => (attr(t, "rel")?.toLowerCase() === "canonical" ? attr(t, "href") : null)).find(Boolean);
  add("canonical", "Canonical tag", canonical ? `Present (${canonical})` : "Not found on the homepage");

  const robots = metaContent(html, "name", "robots");
  if (robots && /noindex/i.test(robots)) add("noindex", "Robots meta", `Homepage is set to "${robots}"`);

  add("viewport", "Mobile viewport tag", metaContent(html, "name", "viewport") ? "Present" : "Missing");
  add("open_graph", "Open Graph tags", metaContent(html, "property", "og:title") ? "Present" : "Not found");
  add("hreflang", "hreflang annotations", /hreflang\s*=/i.test(html) ? "Present" : "Not found");

  const ld = [...html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)];
  const types = new Set<string>();
  for (const m of ld) {
    try {
      const walk = (n: unknown) => {
        if (Array.isArray(n)) n.forEach(walk);
        else if (n && typeof n === "object") {
          const t = (n as Record<string, unknown>)["@type"];
          if (typeof t === "string") types.add(t);
          else if (Array.isArray(t)) t.filter((x): x is string => typeof x === "string").forEach((x) => types.add(x));
          Object.values(n).forEach(walk);
        }
      };
      walk(JSON.parse(m[1]));
    } catch {
      /* ignore malformed JSON-LD */
    }
  }
  add("structured_data", "Structured data (JSON-LD) on homepage", types.size ? [...types].slice(0, 8).join(", ") : "None found");

  const imgs = html.match(/<img\b[^>]*>/gi) ?? [];
  if (imgs.length > 0) {
    const noAlt = imgs.filter((t) => !/\balt\s*=/i.test(t)).length;
    add("image_alt", "Images without alt attribute (homepage)", `${noAlt} of ${imgs.length}`);
  }

  add("https", "HTTPS", url.startsWith("https://") ? "Served over HTTPS" : "Not served over HTTPS");

  let platform: string | null = null;
  for (const p of PLATFORMS) {
    if (p.tests.some((t) => t.test(html))) {
      platform = p.name;
      break;
    }
  }
  // A WordPress site running WooCommerce is reported as WooCommerce (listed first).
  const technologies = [
    ...(platform ? [platform] : []),
    ...TECH.filter((t) => t.test.test(html)).map((t) => t.name),
  ];
  add("platform", "Site platform", platform ?? "Not identifiable from the homepage markup");
  if (technologies.length > (platform ? 1 : 0)) add("technologies", "Detected technologies", technologies.join(", "));

  return { platform, technologies, observations: obs };
}

/** Fetch the homepage plus robots.txt, sitemap and llms.txt and derive observations. */
export async function inspectSite(website: string): Promise<SiteInspection> {
  const home = await safeFetchText(website);
  if (!home || home.status >= 400 || !home.body) {
    return { reachable: false, finalUrl: null, platform: null, technologies: [], observations: [] };
  }
  const base = new URL(home.url);
  const analysis = analyseHtml(home.body, home.url);
  const [robots, sitemap, llms] = await Promise.all([
    safeFetchText(new URL("/robots.txt", base).toString(), { maxBytes: 200_000, timeoutMs: 8_000 }),
    safeFetchText(new URL("/sitemap.xml", base).toString(), { maxBytes: 200_000, timeoutMs: 8_000 }),
    safeFetchText(new URL("/llms.txt", base).toString(), { maxBytes: 50_000, timeoutMs: 8_000 }),
  ]);
  const obs = analysis.observations;
  const robotsOk = robots && robots.status === 200 && /user-agent/i.test(robots.body);
  obs.push({ key: "robots_txt", label: "robots.txt", value: robotsOk ? "Present" : "Not found" });
  if (robotsOk && /^\s*disallow:\s*\/\s*$/im.test(robots!.body)) {
    obs.push({ key: "robots_blocks_all", label: "robots.txt directive", value: "Contains a blanket Disallow: /" });
  }
  const sitemapOk = sitemap && sitemap.status === 200 && /<(urlset|sitemapindex)/i.test(sitemap.body);
  const robotsSitemap = robotsOk && /^\s*sitemap:/im.test(robots!.body);
  obs.push({
    key: "sitemap",
    label: "XML sitemap",
    value: sitemapOk ? "Present at /sitemap.xml" : robotsSitemap ? "Declared in robots.txt" : "Not found at /sitemap.xml or in robots.txt",
  });
  obs.push({ key: "llms_txt", label: "llms.txt", value: llms && llms.status === 200 && llms.body.trim() && !/<html/i.test(llms.body) ? "Present" : "Not found" });
  return { reachable: true, finalUrl: home.url, ...analysis, observations: obs };
}
