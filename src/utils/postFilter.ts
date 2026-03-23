import type { CollectionEntry } from "astro:content";
import { SITE } from "@/config";

const postFilter = ({ data }: CollectionEntry<"blog">) => {
  const isPublishTimePassed =
    Date.now() >
    new Date(data.pubDatetime).getTime() - SITE.scheduledPostMargin;
  const hasReleaseTag = data.tags.includes("release");
  return !data.draft && hasReleaseTag && (import.meta.env.DEV || isPublishTimePassed);
};

export default postFilter;
