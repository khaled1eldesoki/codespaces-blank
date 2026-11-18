# WADA fixtures – provenance and limits

Captured on **2026-10-21** with the assistant's `web_fetch` tool from the official public pages listed below.
`web_fetch` returns a *text/markdown extraction* of each page (page <meta> tags, headings, link text and URLs) – **not the raw
HTML**. These fixtures therefore re-express exactly that observed content (meta tags, headings, the main-content region, link
text and href values, in the order shown) as simple HTML. Navigation and footer boilerplate were omitted. Link URLs, titles,
dates, "Publication date", "In force" and `og:updated_time` values are copied from the fetched pages.

**Limit:** the real pages' tag structure (class names, wrapper elements) was not observed. Parsers are written to depend only on
link URLs, link text, a few meta tags and visible text, but a live run against the real HTML is still required.

| fixture | official URL | observed `og:updated_time` |
|---|---|---|
| news.html | https://www.wada-ama.org/en/media/news | 2025-12-15T15:09:44-05:00 |
| prohibited-list.html | https://www.wada-ama.org/en/resources/world-anti-doping-code-and-international-standards/prohibited-list | 2026-01-19T09:38:43-05:00 |
| international-standards.html | https://www.wada-ama.org/en/what-we-do/international-standards | 2026-09-16T14:19:36-04:00 |
| technical-documents-index.html | https://www.wada-ama.org/en/resources/lab-documents/technical-documents-index | 2026-09-16T11:11:29-04:00 |
