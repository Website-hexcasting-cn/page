import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const posts = defineCollection({
    loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/posts' }),
    schema: z.object({
        title: z.string(),
        date: z.coerce.date(),
        author: z.string(),
        description: z.string().optional(),
    }),
});

export const collections = { posts };