import { z } from 'zod';

// Co-Author validation schema
export const coAuthorSchema = z.object({
    firstName: z.string().min(1, 'First name is required'),
    lastName: z.string().min(1, 'Last name is required'),
    email: z.string().email('Invalid email address'),
    institution: z.string().min(1, 'Institution is required'),
    country: z.string().min(1, 'Country is required'),
});

// Abstract submission validation schema
export const abstractSubmissionSchema = z.object({
    // Author Information
    firstName: z.string().min(1, 'First name is required'),
    lastName: z.string().min(1, 'Last name is required'),
    email: z.string().email('Invalid email address'),
    affiliation: z.string().min(1, 'Affiliation is required'),
    country: z.string().min(1, 'Country is required'),
    phone: z.string().optional(),

    // Abstract Details
    title: z.string().min(10, 'Title must be at least 10 characters').max(500, 'Title too long'),
    category: z.enum(['clinical_pharmacy', 'social_administrative', 'community_pharmacy', 'pharmacology_toxicology', 'pharmacy_education', 'digital_pharmacy']),
    presentationType: z.enum(['oral', 'poster']),
    keywords: z.string().min(1, 'Keywords are required'),

    // Abstract Content (word count validation will be done separately)
    background: z.string().min(50, 'Background must be at least 50 characters'),
    methods: z.string().min(50, 'Methods must be at least 50 characters'),
    results: z.string().min(50, 'Results must be at least 50 characters'),
    conclusion: z.string().min(50, 'Conclusion must be at least 50 characters'),

    // Co-Authors (optional, will be parsed from JSON string in multipart)
    coAuthors: z.array(coAuthorSchema).optional().default([]),

    // Event ID (optional, will default to ACCP 2026 event)
    eventId: z.coerce.number().optional(),
});

// Backoffice: List abstracts
export const abstractListSchema = z.object({
    page: z.coerce.number().min(1).default(1),
    limit: z.coerce.number().min(1).max(1000).default(10),
    search: z.string().optional(),
    eventId: z.coerce.number().optional(),
    status: z.enum(['pending', 'accepted', 'rejected']).optional(),
    category: z.enum(['clinical_pharmacy', 'social_administrative', 'community_pharmacy', 'pharmacology_toxicology', 'pharmacy_education', 'digital_pharmacy']).optional(),
    presentationType: z.enum(['oral', 'poster']).optional(),
});

// Backoffice: Update abstract status
export const updateAbstractStatusSchema = z.object({
    status: z.enum(['pending', 'accepted', 'rejected']),
    comment: z.string().optional(), // For review comment
});
