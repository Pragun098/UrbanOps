"use client";

import { AuthProvider } from "@/lib/auth";
import { LocationProvider } from "@/lib/location";

export default function Providers({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <LocationProvider>{children}</LocationProvider>
    </AuthProvider>
  );
}
