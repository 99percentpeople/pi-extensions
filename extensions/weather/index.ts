/**
 * Weather Extension for Pi
 *
 * Provides weather information for any location.
 *
 * Features:
 *   - Get current weather for any city
 *   - Temperature in Celsius/Fahrenheit
 *   - Weather conditions and humidity
 *   - Wind speed and direction
 *   - Custom rendering with weather icons
 *
 * Usage:
 *   Place in ~/.pi/agent/extensions/weather/
 *   Or: pi -e ./weather/
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";

// ── Types ─────────────────────────────────────────────────────────────

interface WeatherData {
  location: string;
  temperature: number;
  feelsLike: number;
  humidity: number;
  windSpeed: number;
  windDirection: string;
  condition: string;
  icon: string;
  timestamp: number;
}

// ── Weather Icons ─────────────────────────────────────────────────────

const WEATHER_ICONS: Record<string, string> = {
  sunny: "☀️",
  cloudy: "☁️",
  rainy: "🌧️",
  snowy: "❄️",
  stormy: "⛈️",
  foggy: "🌫️",
  windy: "💨",
  partly_cloudy: "⛅",
};

// ── Mock Weather Data ─────────────────────────────────────────────────

// In a real implementation, you would call a weather API
// This is a mock for demonstration purposes
const MOCK_WEATHER: Record<string, WeatherData> = {
  "new york": {
    location: "New York, NY",
    temperature: 22,
    feelsLike: 24,
    humidity: 65,
    windSpeed: 12,
    windDirection: "NW",
    condition: "partly_cloudy",
    icon: "⛅",
    timestamp: Date.now(),
  },
  london: {
    location: "London, UK",
    temperature: 15,
    feelsLike: 13,
    humidity: 78,
    windSpeed: 18,
    windDirection: "SW",
    condition: "rainy",
    icon: "🌧️",
    timestamp: Date.now(),
  },
  tokyo: {
    location: "Tokyo, Japan",
    temperature: 28,
    feelsLike: 30,
    humidity: 70,
    windSpeed: 8,
    windDirection: "E",
    condition: "sunny",
    icon: "☀️",
    timestamp: Date.now(),
  },
  paris: {
    location: "Paris, France",
    temperature: 18,
    feelsLike: 17,
    humidity: 72,
    windSpeed: 14,
    windDirection: "W",
    condition: "cloudy",
    icon: "☁️",
    timestamp: Date.now(),
  },
};

// ── Helpers ───────────────────────────────────────────────────────────

function getWeather(location: string): WeatherData | null {
  const normalized = location.toLowerCase().trim();
  
  // Check exact match first
  if (MOCK_WEATHER[normalized]) {
    return MOCK_WEATHER[normalized];
  }
  
  // Check partial match
  for (const [key, data] of Object.entries(MOCK_WEATHER)) {
    if (key.includes(normalized) || normalized.includes(key)) {
      return data;
    }
  }
  
  return null;
}

function formatTemperature(temp: number, unit: "C" | "F" = "C"): string {
  if (unit === "F") {
    return `${Math.round((temp * 9) / 5 + 32)}°F`;
  }
  return `${temp}°C`;
}

function getConditionEmoji(condition: string): string {
  return WEATHER_ICONS[condition] || "🌤️";
}

// ── Extension ─────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "weather",
    label: "Weather",
    description: "Get current weather information for a location",
    promptSnippet: "Get weather information for any city",
    promptGuidelines: [
      "Use weather when the user asks about weather conditions, temperature, or climate.",
      "Provide temperature in both Celsius and Fahrenheit when possible.",
    ],
    parameters: Type.Object({
      location: Type.String({ description: "City or location name" }),
      unit: Type.Optional(
        StringEnum(["C", "F"] as const, {
          description: "Temperature unit (Celsius or Fahrenheit)",
        })
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const weather = getWeather(params.location);

      if (!weather) {
        return {
          content: [
            {
              type: "text",
              text: `Weather data not available for "${params.location}". Available locations: New York, London, Tokyo, Paris.`,
            },
          ],
          details: { error: "Location not found" },
        };
      }

      const unit = params.unit || "C";
      const temp = formatTemperature(weather.temperature, unit);
      const feelsLike = formatTemperature(weather.feelsLike, unit);
      const icon = getConditionEmoji(weather.condition);

      const text = [
        `${icon} Weather in ${weather.location}`,
        `Temperature: ${temp} (feels like ${feelsLike})`,
        `Humidity: ${weather.humidity}%`,
        `Wind: ${weather.windSpeed} km/h ${weather.windDirection}`,
        `Condition: ${weather.condition.replace("_", " ")}`,
      ].join("\n");

      return {
        content: [{ type: "text", text }],
        details: { ...weather, unit },
      };
    },

    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const location = args.location || "...";
      text.setText(
        theme.fg("toolTitle", theme.bold("weather ")) +
          theme.fg("accent", location)
      );
      return text;
    },

    renderResult(result, { isPartial }, theme) {
      if (isPartial) {
        return new Text(theme.fg("warning", "Fetching weather..."), 0, 0);
      }

      const content =
        result.content[0]?.type === "text" ? result.content[0].text : "";
      const lines = content.split("\n").map((line) => {
        if (line.includes("Weather in")) {
          return theme.fg("accent", line);
        }
        if (line.includes("Temperature:")) {
          return theme.fg("success", line);
        }
        return theme.fg("foreground", line);
      });

      return new Text(lines.join("\n"), 0, 0);
    },
  });

  // Register command for quick weather lookup
  pi.registerCommand("weather", {
    description: "Get weather for a location",
    getArgumentCompletions: (prefix: string) => {
      const locations = ["New York", "London", "Tokyo", "Paris"];
      return locations
        .filter((l) => l.toLowerCase().startsWith(prefix.toLowerCase()))
        .map((l) => ({ value: l, label: l }));
    },
    handler: async (args, ctx) => {
      if (!args) {
        ctx.ui.notify("Usage: /weather <location>", "info");
        return;
      }

      const weather = getWeather(args);
      if (!weather) {
        ctx.ui.notify(`Weather not available for "${args}"`, "error");
        return;
      }

      const icon = getConditionEmoji(weather.condition);
      const temp = formatTemperature(weather.temperature);

      ctx.ui.notify(
        `${icon} ${weather.location}: ${temp}, ${weather.condition.replace("_", " ")}`,
        "info"
      );
    },
  });
}
