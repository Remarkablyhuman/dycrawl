import { supabase } from "@/lib/supabase";
import type { AdminStatus, HotPost } from "@/lib/supabase";
import { AdminBoard } from "@/components/AdminBoard";

const STATUS_FILTERS: { label: string; value: AdminStatus | "all" }[] = [
  { label: "All",       value: "all"       },
  { label: "New",       value: "new"       },
  { label: "Candidate", value: "candidate" },
  { label: "Queued",    value: "queued"    },
  { label: "Done",      value: "done"      },
  { label: "Ignored",   value: "ignored"   },
];

export const revalidate = 0;

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; sort?: string; keyword?: string }>;
}) {
  const params = await searchParams;
  const status = params.status ?? "new";
  const sort   = params.sort   ?? "trend";
  const keyword = params.keyword ?? "";

  let query = supabase
    .from("hot_posts")
    .select("*");

  if (status !== "all") {
    query = query.eq("admin_status", status);
  }
  if (keyword) {
    query = query.eq("keyword_source", keyword);
  }

  if (sort === "opportunity") {
    query = query.order("opportunity_score", { ascending: false });
  } else if (sort === "recency") {
    query = query.order("publish_time", { ascending: false });
  } else {
    query = query.order("trend_score", { ascending: false });
  }

  query = query.limit(100);

  const { data: posts, error } = await query;

  // Fetch distinct keywords for filter
  const { data: keywordsData } = await supabase
    .from("hot_posts")
    .select("keyword_source")
    .order("keyword_source");

  const keywords = [...new Set((keywordsData ?? []).map((r) => r.keyword_source).filter(Boolean))];

  return (
    <AdminBoard
      posts={(posts ?? []) as HotPost[]}
      statusFilters={STATUS_FILTERS}
      currentStatus={status}
      currentSort={sort}
      currentKeyword={keyword}
      keywords={keywords}
      error={error?.message}
    />
  );
}
