export type Reading = {
  start: number;
  kwh: number;
  sourceCostGbp?: number;
  ev?: number;
  estimated?: boolean;
};
export type Stream = {
  id: string;
  name: string;
  source: "glow" | "csv" | "mqtt";
  resourceId?: string;
  lastSync?: string;
};
export type LiveReading = {
  stream: string;
  time: number;
  powerKw: number;
  cumulativeKwh: number;
};
