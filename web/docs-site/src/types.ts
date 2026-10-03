export type NavItem = {
  title: string;
  path: string;
  slug: string;
};

export type SiteVersion = {
  name: string;
  alias: string;
};

export type PublicSite = {
  project: {
    name: string;
    slug: string;
    org: string;
  };
  title: string;
  nav: NavItem[];
  versions: SiteVersion[];
  version: string;
};

export type DocHeading = {
  level: number;
  text: string;
  id: string;
};

export type PublicDoc = {
  title: string;
  html: string;
  headings: DocHeading[];
  description: string;
};

export type PublicPage = {
  path: string;
  doc: PublicDoc;
};

export type SearchResult = {
  path: string;
  title: string;
  headings: string;
  body: string;
};

export type PublicSearch = {
  results: SearchResult[];
};
