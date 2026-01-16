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
