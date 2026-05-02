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

export type CasePoint = {
  caseId: string;
  caseName: string;
  success: number;
  failed: number;
  skipped: number;
};

export default function CaseBar({ data }: { data: CasePoint[] }) {
  return (
    <div style={{ width: "100%", height: 260 }}>
      <ResponsiveContainer>
        <BarChart
          data={data}
          layout="vertical"
          margin={{ top: 10, right: 20, left: 60, bottom: 0 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
          <XAxis type="number" fontSize={11} tick={{ fill: "#666" }} allowDecimals={false} />
          <YAxis
            type="category"
            dataKey="caseName"
            width={120}
            fontSize={11}
            tick={{ fill: "#444" }}
          />
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
