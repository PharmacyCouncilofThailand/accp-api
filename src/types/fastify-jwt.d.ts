import "@fastify/jwt";

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: {
      id: number;
      email: string;
      role: string;
      assignedCategories?: string[];
      assignedPresentationTypes?: string[];
    };
    user: {
      id: number;
      email: string;
      role: string;
      assignedCategories?: string[];
      assignedPresentationTypes?: string[];
    };
  }
}
