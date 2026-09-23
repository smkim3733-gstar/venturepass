export type ConfirmationKind = "신규" | "재확인";

export interface Company {
  /** Original workbook serial number. Company names are not unique identifiers. */
  id: number;
  name: string;
  region: string;
  address: string;
  industry: string;
  detailIndustry: string;
  product: string;
  /** Confirmation validity dates, never incorporation dates. */
  validFrom: string;
  validUntil: string;
  confirmationKind: ConfirmationKind;
}

export interface Distribution {
  label: string;
  count: number;
  /** Fraction between zero and one, with innovation records as denominator. */
  share: number;
}

export interface VentureSummary {
  source: string;
  sourceSha256: string;
  snapshotMonth: string;
  total: number;
  innovation: number;
  innovationShare: number;
  industries: Distribution[];
  regions: Distribution[];
  kinds: Distribution[];
  detailIndustryCount: number;
  detailIndustries: Distribution[];
  notes: string[];
}

export interface CompanyFilters {
  regions: string[];
  industries: string[];
  kinds: ConfirmationKind[];
}

export interface CompanyQuery {
  q?: string;
  region?: string;
  industry?: string;
  kind?: string;
  page?: number;
  pageSize?: number;
}

export interface CompanyQueryResult {
  items: Company[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}
