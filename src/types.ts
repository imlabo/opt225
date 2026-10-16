export type Product = "call" | "put" | "fut";
export type Investor = "individual" | "corporate" | "foreign" | "securities" | "proprietary";

export const INVESTORS: Investor[] = ["individual", "corporate", "foreign", "securities", "proprietary"];
export const INVESTOR_LABEL: Record<Investor, string> = {
  individual: "個人",
  corporate: "法人",
  foreign: "海外投資家",
  securities: "証券会社",
  proprietary: "自己",
};

export interface FlowRow {
  product: Product;
  investor: Investor;
  sell: number;
  buy: number;
}

export interface WeekData {
  weekStart: string;
  weekEnd: string;
  sourceUrl?: string;
  isSample?: boolean;
  flows: FlowRow[];
}

export interface Env {
  DB: D1Database;
  SITE_URL: string;
  JPX_INDEX_URL: string;
  X_POST_ENABLED: string;
  ADMIN_TOKEN?: string;
  X_API_KEY?: string;
  X_API_SECRET?: string;
  X_ACCESS_TOKEN?: string;
  X_ACCESS_SECRET?: string;
}
