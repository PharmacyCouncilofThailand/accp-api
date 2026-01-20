// ACCP Shared Types
// เพิ่ม shared types ที่ใช้ร่วมกันระหว่าง apps

// API Response Types
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

// User Types
export type UserRole = 'thstd' | 'interstd' | 'thpro' | 'interpro' | 'admin';
export type AccountStatus = 'pending_approval' | 'active' | 'rejected';
export type StaffRole = 'admin' | 'organizer' | 'reviewer' | 'staff' | 'verifier';

export interface User {
  id: number;
  email: string;
  firstName: string;
  lastName: string;
  role: UserRole;
  status: AccountStatus;
  country?: string;
  institution?: string;
  phone?: string;
}

export interface BackofficeUser {
  id: number;
  email: string;
  firstName: string;
  lastName: string;
  role: StaffRole;
  isActive: boolean;
}

// Event Types
export type EventStatus = 'draft' | 'published' | 'cancelled' | 'completed';
export type EventType = 'single_room' | 'multi_session';

export interface Event {
  id: number;
  eventCode: string;
  eventName: string;
  description?: string;
  eventType: EventType;
  location?: string;
  startDate: Date;
  endDate: Date;
  status: EventStatus;
}

// Registration Types
export type RegistrationStatus = 'confirmed' | 'cancelled';
export type OrderStatus = 'pending' | 'paid' | 'cancelled';

export interface Registration {
  id: number;
  regCode: string;
  eventId: number;
  email: string;
  firstName: string;
  lastName: string;
  status: RegistrationStatus;
}

// Abstract Types
export type AbstractCategory =
  | 'clinical_pharmacy'
  | 'social_administrative'
  | 'pharmaceutical_sciences'
  | 'pharmacology_toxicology'
  | 'pharmacy_education'
  | 'digital_pharmacy';

export type PresentationType = 'oral' | 'poster';
export type AbstractStatus = 'pending' | 'accepted' | 'rejected';

export interface Abstract {
  id: number;
  title: string;
  category: AbstractCategory;
  presentationType: PresentationType;
  status: AbstractStatus;
}

// Speaker Types
export type SpeakerType = 'keynote' | 'panelist' | 'moderator' | 'guest';

export interface Speaker {
  id: number;
  firstName: string;
  lastName: string;
  email?: string;
  organization?: string;
  position?: string;
  bio?: string;
  photoUrl?: string;
}

// ============================================================================
// JWT Payload Type (from authentication)
// ============================================================================

export interface JWTPayload {
  id: number;
  email: string;
  role: StaffRole;
}

// ============================================================================
// Update Payload Types (for PATCH requests)
// ============================================================================

export interface EventUpdatePayload {
  conferenceCode?: string;
  eventCode?: string;
  eventName?: string;
  description?: string | null;
  eventType?: EventType;
  location?: string | null;
  startDate?: Date | string;
  endDate?: Date | string;
  maxCapacity?: number;
  status?: EventStatus;
  abstractStartDate?: Date | string;
  abstractEndDate?: Date | string;
  earlyBirdEndDate?: Date | string;
  registrationStartDate?: Date | string;
  registrationEndDate?: Date | string;
  updatedAt?: Date;
}

export interface SessionUpdatePayload {
  sessionName?: string;
  sessionCode?: string;
  description?: string;
  room?: string | null;
  startTime?: Date | string;
  endTime?: Date | string;
  maxCapacity?: number;
  speakers?: string;
  updatedAt?: Date;
}

export interface TicketTypeUpdatePayload {
  name?: string;
  description?: string;
  category?: string;
  price?: string;
  thaiPrice?: string;
  earlyBirdPrice?: string;
  thaiEarlyBirdPrice?: string;
  quota?: number;
  saleStartDate?: Date | string;
  saleEndDate?: Date | string;
  isActive?: boolean;
  updatedAt?: Date;
}

export interface BackofficeUserUpdatePayload {
  firstName?: string;
  lastName?: string;
  email?: string;
  role?: StaffRole;
  isActive?: boolean;
  passwordHash?: string;
  updatedAt?: Date;
}

