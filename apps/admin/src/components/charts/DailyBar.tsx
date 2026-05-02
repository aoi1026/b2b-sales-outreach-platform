"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";

export type DailyPoint = {
  date: string;
  success: number;
  failed: number;
  skipped: number;
};

export default function DailyBar({ data }: { data: DailyPoint[] }) {
  return (
    <div style={{ width: "100%", height: 240 }}>
      <ResponsiveContainer>
        <BarChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
          <XAxis
            dataKey="date"
            tickFormatter={(d: string) => d.slice(5)}
            fontSize={11}
            tick={{ fill: "#666" }}
          />
          <YAxis fontSize={11} tick={{ fill: "#666" }} allowDecimals={false} />
          <Tooltip contentStyle={{ fontSize: 12 }} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey="success" stackId="a" fill="#10b981" name="成功" />
          <Bar dataKey="failed" stackId="a" fill="#ef4444" name="失敗" />
          <Bar dataKey="skipped" stackId="a" fill="#9ca3af" name="スキップ" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
