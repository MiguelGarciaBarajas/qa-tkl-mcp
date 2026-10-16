import { useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { Icon, type IconName } from "./Icon";
import "./Layout.css";

const NAV_ITEMS = [
  { to: "/investigate", label: "Investigate", icon: "search", group: "Workspace" },
  { to: "/insights", label: "Quality Insights", icon: "chart", group: "Workspace" },
  { to: "/reviews", label: "Review Queue", icon: "warning", group: "Workspace" },
  { to: "/sources", label: "Sources", icon: "link", group: "Administration" },
  { to: "/knowledge", label: "Knowledge Health", icon: "database", group: "Administration" },
] satisfies Array<{
  to: string;
  label: string;
  icon: IconName;
  group: string;
}>;

const NAV_GROUPS = ["Workspace", "Administration"];

function Navigation({ close }: { close: () => void }) {
  return (
    <nav className="layout__nav" aria-label="Primary navigation">
      {NAV_GROUPS.map((group) => (
        <div className="layout__nav-group" key={group}>
          <p className="layout__nav-heading">{group}</p>
          {NAV_ITEMS.filter((item) => item.group === group).map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              onClick={close}
              className={({ isActive }) => `layout__nav-link${isActive ? " layout__nav-link--active" : ""}`}
            >
              <Icon name={item.icon} size={19} />
              <span>{item.label}</span>
            </NavLink>
          ))}
        </div>
      ))}
    </nav>
  );
}

export function Layout() {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div className="layout">
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <aside className={`layout__sidebar${menuOpen ? " layout__sidebar--open" : ""}`}>
        <div className="layout__brand">
          <div className="layout__brand-mark"><Icon name="sparkles" size={22} /></div>
          <div>
            <h1>TKL Dashboard</h1>
            <span>Quality Intelligence</span>
          </div>
          <button
            aria-label={menuOpen ? "Close navigation menu" : "Open navigation menu"}
            aria-controls="primary-navigation"
            aria-expanded={menuOpen}
            className="layout__menu-toggle"
            onClick={() => setMenuOpen((open) => !open)}
            type="button"
          >
            <Icon name="menu" size={20} />
            <span>Menu</span>
          </button>
        </div>
        <div id="primary-navigation">
          <Navigation close={() => setMenuOpen(false)} />
        </div>
      </aside>
      <div className="layout__main">
        <header className="layout__topbar">
          <div>
            <span className="layout__breadcrumb">Vehicle Solutions / TitleTec / Titling</span>
            <strong>FL quality workspace</strong>
          </div>
          <div className="layout__identity">
            <Icon name="shield" size={19} />
            <div>
              <strong>Protected access</strong>
              <span>Workspace-scoped authorization</span>
            </div>
          </div>
        </header>
        <main className="layout__content" id="main-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
