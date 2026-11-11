"use client";

/**
 * Sidebar layout + route guard. Redirects anonymous users to /login and users
 * without one of `roles` to their own home page. The API enforces the same
 * rules; this only keeps people off screens they can't use.
 */

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import type { Role } from "@/lib/api";
import { homeFor, isStaff, useAuth } from "@/lib/auth";

type Props = {
  title: string;
  roles?: Role[];
  actions?: React.ReactNode;
  children: React.ReactNode;
};

const STAFF_NAV = [
  { href: "/", label: "Dashboard" },
  { href: "/incidents", label: "Incidents" },
  { href: "/livemap", label: "Live Map" },
];

const COMMON_NAV = [
  { href: "/report", label: "Report issue" },
  { href: "/my-reports", label: "My reports" },
];

export default function AppShell({ title, roles, actions, children }: Props) {
  const { status, user, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  const allowed = status === "authenticated" && user && (!roles || roles.includes(user.role));

  useEffect(() => {
    if (status === "anonymous") router.replace("/login");
    else if (status === "authenticated" && user && roles && !roles.includes(user.role)) {
      router.replace(homeFor(user.role));
    }
  }, [status, user, roles, router]);

  if (!allowed) {
    return (
      <main className="loading-screen">
        <span className="mono">Loading…</span>
      </main>
    );
  }

  const nav = isStaff(user.role) ? [...STAFF_NAV, ...COMMON_NAV] : COMMON_NAV;

  return (
    <main className="app">
      <aside className="sidebar">
        <div className="logo-container">
          <span className="logo-text">UrbanOps</span>
        </div>

        <nav>
          {nav.map((item) => (
            <Link key={item.href} href={item.href} className={`nav-item ${pathname === item.href ? "active" : ""}`}>
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="user-info">
            <span className="user-name">{user.name}</span>
            <span className="user-role">
              {user.role.toUpperCase()} · {user.email}
            </span>
            <button
              type="button"
              className="location-button logout-button"
              onClick={() => {
                logout();
                router.replace("/login");
              }}
            >
              Sign out
            </button>
          </div>
        </div>
      </aside>

      <section className="content">
        <header className="topbar">
          <h1 className="page-title">{title}</h1>
          {actions}
        </header>
        {children}
      </section>
    </main>
  );
}
