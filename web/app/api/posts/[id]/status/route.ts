import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { status } = await req.json();

  const valid = ["new", "ignored", "candidate", "queued", "done"];
  if (!valid.includes(status)) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }

  const { data: post, error } = await supabaseAdmin
    .from("hot_posts")
    .update({ admin_status: status })
    .eq("id", id)
    .select("url")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // When queued, create a media job for the worker to pick up
  if (status === "queued") {
    const { error: jobError } = await supabaseAdmin
      .from("post_media_jobs")
      .upsert(
        { hot_post_id: id, status: "pending", source_video_url: post.url },
        { onConflict: "hot_post_id", ignoreDuplicates: true }
      );
    if (jobError) return NextResponse.json({ error: jobError.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
