# The sitemap `lastmod` standard

Shipped in `v0.9.0`. Applies to every site consuming `build-websites-tools`.

## The rule

For every sitemap URL:

> **`lastmod` = the last substantive content change.**

None of the following are valid sources on their own:

- build time
- deployment time
- process start time
- framework execution time
- current time generated indiscriminately for every route

## Why this is a gate and not a style preference

On 2026-07-27 an audit of `siteclinic.io` found that **33 of its 54 sitemap URLs
carried one identical timestamp**: `2026-07-23T08:15:38.802Z`, the moment of the
last deploy.

The cause was four characters of ordinary-looking code in `src/app/sitemap.ts`:

```ts
const now = new Date();          // evaluated once per BUILD
// ...
{ url: `${base}/privacy`, lastModified: now }
{ url: `${base}/about`,   lastModified: now }
```

Next.js re-evaluates the sitemap on every build, so every deploy restamped every
page as "changed today." `/privacy` had not changed since May. `/about` had not
changed since May either. The site publishes blog posts twice a week, and each
of those unrelated commits re-dated the entire site.

Google uses `lastmod` **only while it is consistently and verifiably accurate**,
and discounts the signal site-wide once a sitemap over-reports freshness. At the
time of the audit, Search Console showed 35 of that site's URLs sitting in
"Discovered - currently not indexed" - known to Google, never fetched - with no
trustworthy freshness hint to prioritize them.

An honest but stale date costs nothing. A date that is always fresh costs the
whole signal.

## What the gates check

Two gates, deliberately split by what they can see.

### `gate-sitemap-source` (static, no server)

Reads the sitemap's **source** and rejects the construct that produces the lie.

| Code | What it catches |
|---|---|
| `build-scoped-shared-date` | `const now = new Date()` reused across routes |
| `bare-new-date` | `new Date()` / `new Date().toISOString()` with no argument |
| `date-now` | `Date.now()` used as freshness |

Each finding reports **file, line, the matched source line, and remediation**.

Explicitly allowed, because these read real content metadata:

```ts
lastModified: new Date(post.updatedAt)                    // stored metadata
lastModified: new Date(entry.published ?? entry.target_date)
lastModified: new Date("2026-06-07")                      // literal content date
```

Commented-out code and string literals are not violations - the scanner blanks
comments and string bodies before matching, preserving line numbers.

For the rare legitimate clock read inside a sitemap module (dropping posts
scheduled in the future, say), mark the single line:

```ts
const clock = new Date(); // bwt-allow-build-time-date
```

It is a per-line acknowledgement on purpose. There is no file-wide switch.

### `gate-seo` (runtime, against the served sitemap)

Parses `/sitemap.xml` as **structured XML records** (`loc`, `lastmod`,
`changefreq`, `priority`) rather than scraping `<loc>` with a regex, which also
fixes entity-escaped URLs and namespace-prefixed documents. Then validates:

| Code | What it catches |
|---|---|
| `missing-lastmod` | a URL with no `<lastmod>` |
| `invalid-lastmod` | an unparseable value |
| `future-lastmod` | a date beyond `maxFutureSkewMinutes` |
| `duplicate-loc` | the same location listed twice |
| `build-time-cluster` | N routes sharing one **build-shaped instant** |
| `build-time-smear` | N routes with distinct build-shaped instants inside one build window |
| `suspicious-lastmod-cluster` | N routes sharing one **calendar day**, above the configured threshold |

The distinction between the last two matters. `2026-06-07T00:00:00.000Z` shared
by forty pages is plausible - a site really can launch forty pages on one day,
and that is reported only as a tunable threshold. `2026-07-23T08:15:38.802Z`
shared by forty pages is a build stamp, always, and fails regardless of the
threshold.

## Writing a compliant sitemap

Use the shared helper. It cannot produce a build-time date, because it refuses
to invent one.

```ts
import type { MetadataRoute } from "next";
import { defineSitemap, toNextSitemap, newestDate } from "build-websites-tools/sitemap";
import { POSTS } from "@/lib/posts";

export default function sitemap(): MetadataRoute.Sitemap {
  return toNextSitemap(
    defineSitemap({
      baseUrl: "https://example.com",
      // Conservative, stable, explicitly declared. Used only when a route
      // supplies no date of its own. Omit it and a missing date is a build
      // failure rather than a guess.
      fallbackLastModified: "2026-05-12",
      routes: [
        { path: "/",        lastModified: "2026-07-09", changeFrequency: "weekly",  priority: 1 },
        { path: "/about",   lastModified: "2026-05-12", changeFrequency: "monthly", priority: 0.8 },
        { path: "/privacy", lastModified: "2026-07-02", changeFrequency: "yearly",  priority: 0.3 },

        // A listing page is the one place "recent" is legitimately true:
        // its date is its newest child's date.
        { path: "/blog", children: POSTS.map((p) => p.published), changeFrequency: "weekly" },

        // Per-item content dates come from stored metadata.
        ...POSTS.map((p) => ({ path: `/blog/${p.slug}`, lastModified: p.published })),
      ],
    }),
  );
}
```

### Keeping the dates honest over time

Declared dates are only as good as the discipline around them. Add one step to
whatever your site's "add a page" checklist already is:

> When you change a page's content, bump its date.

A forgotten bump under-reports freshness, which is safe. The failure mode this
standard exists to stop is the opposite one.

## Migration path for existing consumers

Enforcement is **on by default**. A standard that defaults to off is not a
standard. But you do not have to fix everything in the same commit as the
upgrade.

**Step 1 - upgrade in warn mode.** Bump the pin and add:

```json
{
  "sitemap": { "enforce": false }
}
```

Both gates now run and print every finding in full, with exact URLs and source
lines, but do not fail the build. There is no option to hide the findings - the
only choice is whether they block.

**Step 2 - read the output.** It names the file and line of every prohibited
construct, and every URL with a bad date.

**Step 3 - fix the sitemap** using the helper above.

**Step 4 - turn enforcement on** by deleting `"enforce": false`.

### Tuning rather than fixing

Two settings exist for cases where the finding is wrong, not the site:

```json
{
  "sitemap": {
    "dynamicListingRoutes": ["/blog"],
    "maxIdenticalLastmodCluster": 40,
    "allowMissingLastmodRoutes": ["/legacy-landing"]
  }
}
```

`dynamicListingRoutes` exempts listing pages from cluster detection.
`maxIdenticalLastmodCluster` is the honest escape hatch for a site that really
did ship many pages on one day. Neither can suppress `build-time-cluster` or
`build-time-smear`, because no threshold makes a build instant a content date.

## Wiring the new gate

```json
{
  "scripts": {
    "gate:sitemap-source": "gate-sitemap-source",
    "gate:all": "npm run gate:sitemap-source && npm run gate:seo"
  }
}
```

A site with no dynamic sitemap source (a fully static `public/sitemap.xml`)
passes `gate-sitemap-source` with a stated scope limit: there is no build-time
construct to police, and `gate-seo` still validates the served document.
