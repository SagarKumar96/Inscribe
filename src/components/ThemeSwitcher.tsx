import { useEffect, useMemo, useState } from "react";

const THEMES = [
    "light",
    "dark",
    "cupcake",
    "emerald",
    "corporate",
    "synthwave",
    "retro",
    "cyberpunk",
    "valentine",
    "halloween",
    "garden",
    "forest",
    "aqua",
    "lofi",
    "pastel",
    "fantasy",
    "wireframe",
    "black",
    "luxury",
    "dracula",
    "cmyk",
    "autumn",
    "business",
    "acid",
    "lemonade",
    "night",
    "coffee",
    "winter",
];

function applyTheme(theme: string) {
    document.documentElement.setAttribute("data-theme", theme);
}

export function ThemeSwitcher() {
    const [theme, setTheme] = useState<string>(() => localStorage.getItem("inscribe:theme") || "business");

    useEffect(() => {
        applyTheme(theme);
        localStorage.setItem("inscribe:theme", theme);
    }, [theme]);

    const options = useMemo(() => THEMES, []);

    return (
        <label className="label gap-2 cursor-pointer">
            <span className="label-text">Theme</span>
            <select className="select select-bordered select-sm" value={theme} onChange={(e) => setTheme(e.target.value)}>
                {options.map((t) => (
                    <option key={t} value={t}>{t}</option>
                ))}
            </select>
        </label>
    );
}

export default ThemeSwitcher;


