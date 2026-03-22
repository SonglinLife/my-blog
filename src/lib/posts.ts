import { getCollection } from 'astro:content';

/** Get only published (release-tagged) posts, sorted by date descending */
export async function getPublishedPosts() {
	const posts = await getCollection('blog', ({ data }) =>
		data.tags.includes('release')
	);
	return posts.sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());
}
