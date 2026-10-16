import { NavLink, Outlet } from "react-router-dom";

interface SectionTab {
  to: string;
  label: string;
  end?: boolean;
}

export function SectionTabs({
  label,
  tabs,
}: {
  label: string;
  tabs: SectionTab[];
}) {
  return (
    <>
      <nav className="section-tabs" aria-label={label}>
        {tabs.map((tab) => (
          <NavLink
            className={({ isActive }) =>
              `section-tabs__link${isActive ? " section-tabs__link--active" : ""}`
            }
            end={tab.end}
            key={tab.to}
            to={tab.to}
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </>
  );
}
