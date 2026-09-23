"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { Distribution } from "@/lib/venture-types";

export function IndustryChart({ data }: { data: Distribution[] }) {
  return (
    <div
      className="h-[290px] w-full"
      role="img"
      aria-label={data.map((item) => `${item.label} ${item.count.toLocaleString()}개`).join(", ")}
    >
      <ResponsiveContainer width="100%" height="100%" minWidth={0}>
        <BarChart
          data={data}
          layout="vertical"
          margin={{ top: 4, right: 20, bottom: 0, left: 0 }}
          barSize={18}
        >
          <CartesianGrid horizontal={false} stroke="#e8edf2" strokeDasharray="3 5" />
          <XAxis
            type="number"
            axisLine={false}
            tickLine={false}
            tick={{ fill: "#8290a3", fontSize: 11 }}
            tickFormatter={(value) => `${Number(value) / 1000}천`}
          />
          <YAxis
            type="category"
            dataKey="label"
            width={111}
            axisLine={false}
            tickLine={false}
            tick={{ fill: "#526179", fontSize: 11 }}
          />
          <Tooltip
            cursor={{ fill: "#f4f7fa" }}
            formatter={(value) => [`${Number(value).toLocaleString()}개`, "확인기업"]}
            contentStyle={{ borderRadius: 12, border: "1px solid #e6ebf1", fontSize: 13 }}
          />
          <Bar dataKey="count" radius={[0, 5, 5, 0]}>
            {data.map((item, index) => (
              <Cell
                key={item.label}
                fill={index === 0 ? "#087f8c" : index === 1 ? "#65b6b9" : "#bbd3da"}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
