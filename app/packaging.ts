export type PackagingPreset = "tianzong_magazine" | "light" | "clean" | "none" | "custom";

export type PackagingSettings = {
  version: "tianpack-1.0";
  enabled: boolean;
  preset: PackagingPreset;
  captions: {
    enabled: boolean;
    style: "杂志衬线" | "清透无衬线" | "高对比";
    size: number;
    position: "下方" | "中下";
    keywordHighlight: boolean;
  };
  keywordPunch: {
    enabled: boolean;
    scale: number;
    density: "只放金句" | "标准" | "强化";
  };
  flowerText: {
    enabled: boolean;
    style: "粉白杂志" | "黑白画报" | "极简标签";
    density: "克制" | "标准" | "强化";
  };
  tracking: {
    enabled: boolean;
    followFace: boolean;
    intensity: number;
  };
  animation: {
    enabled: boolean;
    style: "轻推近" | "杂志滑入" | "呼吸缩放";
    intensity: number;
  };
  transitions: {
    enabled: boolean;
    style: "无感叠化" | "节奏硬切" | "柔和闪白";
    durationMs: number;
  };
  effects: {
    enabled: boolean;
    style: "原片优先" | "冷白时装" | "轻颗粒";
    intensity: number;
  };
  soundEffects: {
    enabled: boolean;
    density: "克制" | "标准" | "强化";
    volume: number;
  };
  bgm: {
    enabled: boolean;
    mood: "轻电子" | "时装律动" | "柔和氛围";
    volume: number;
    autoDucking: boolean;
  };
};

export type PackagingSection = Exclude<keyof PackagingSettings, "version" | "enabled" | "preset">;

function clamp(value: unknown, fallback: number, min: number, max: number) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

export function packagingPreset(
  mode: "聊播" | "带货",
  preset: Exclude<PackagingPreset, "custom"> = "tianzong_magazine",
): PackagingSettings {
  const base: PackagingSettings = {
    version: "tianpack-1.0",
    enabled: preset !== "none",
    preset,
    captions: {
      enabled: true,
      style: "杂志衬线",
      size: 66,
      position: "下方",
      keywordHighlight: true,
    },
    keywordPunch: {
      enabled: true,
      scale: 108,
      density: "只放金句",
    },
    flowerText: {
      enabled: true,
      style: "粉白杂志",
      density: mode === "带货" ? "标准" : "克制",
    },
    tracking: {
      enabled: true,
      followFace: true,
      intensity: 12,
    },
    animation: {
      enabled: true,
      style: "轻推近",
      intensity: 26,
    },
    transitions: {
      enabled: true,
      style: "无感叠化",
      durationMs: 260,
    },
    effects: {
      enabled: true,
      style: "原片优先",
      intensity: 16,
    },
    soundEffects: {
      enabled: true,
      density: "克制",
      volume: 22,
    },
    bgm: {
      enabled: true,
      mood: mode === "带货" ? "时装律动" : "轻电子",
      volume: 9,
      autoDucking: true,
    },
  };

  if (preset === "light") {
    return {
      ...base,
      preset,
      keywordPunch: { ...base.keywordPunch, scale: 104 },
      flowerText: { ...base.flowerText, enabled: false },
      tracking: { ...base.tracking, intensity: 6 },
      animation: { ...base.animation, intensity: 12 },
      effects: { ...base.effects, enabled: false },
      soundEffects: { ...base.soundEffects, enabled: false },
      bgm: { ...base.bgm, volume: 6 },
    };
  }

  if (preset === "clean") {
    return {
      ...base,
      preset,
      keywordPunch: { ...base.keywordPunch, enabled: false },
      flowerText: { ...base.flowerText, enabled: false },
      tracking: { ...base.tracking, enabled: false },
      animation: { ...base.animation, enabled: false },
      transitions: { ...base.transitions, enabled: false },
      effects: { ...base.effects, enabled: false },
      soundEffects: { ...base.soundEffects, enabled: false },
      bgm: { ...base.bgm, enabled: false },
    };
  }

  if (preset === "none") {
    return {
      ...base,
      enabled: false,
      preset,
      captions: { ...base.captions, enabled: false },
      keywordPunch: { ...base.keywordPunch, enabled: false },
      flowerText: { ...base.flowerText, enabled: false },
      tracking: { ...base.tracking, enabled: false },
      animation: { ...base.animation, enabled: false },
      transitions: { ...base.transitions, enabled: false },
      effects: { ...base.effects, enabled: false },
      soundEffects: { ...base.soundEffects, enabled: false },
      bgm: { ...base.bgm, enabled: false },
    };
  }

  return base;
}

export function normalizePackagingSettings(
  input: unknown,
  mode: "聊播" | "带货" = "聊播",
): PackagingSettings {
  const fallback = packagingPreset(mode);
  if (!input || typeof input !== "object") return fallback;
  const value = input as Partial<Record<keyof PackagingSettings, unknown>>;
  const readObject = (key: PackagingSection) =>
    value[key] && typeof value[key] === "object"
      ? value[key] as Record<string, unknown>
      : {};
  const captions = readObject("captions");
  const keywordPunch = readObject("keywordPunch");
  const flowerText = readObject("flowerText");
  const tracking = readObject("tracking");
  const animation = readObject("animation");
  const transitions = readObject("transitions");
  const effects = readObject("effects");
  const soundEffects = readObject("soundEffects");
  const bgm = readObject("bgm");
  const preset = ["tianzong_magazine", "light", "clean", "none", "custom"].includes(String(value.preset))
    ? value.preset as PackagingPreset
    : fallback.preset;

  const pick = <T extends string>(candidate: unknown, allowed: readonly T[], defaultValue: T) =>
    allowed.includes(candidate as T) ? candidate as T : defaultValue;
  const bool = (candidate: unknown, defaultValue: boolean) =>
    typeof candidate === "boolean" ? candidate : defaultValue;

  return {
    version: "tianpack-1.0",
    enabled: bool(value.enabled, fallback.enabled),
    preset,
    captions: {
      enabled: bool(captions.enabled, fallback.captions.enabled),
      style: pick(captions.style, ["杂志衬线", "清透无衬线", "高对比"] as const, fallback.captions.style),
      size: clamp(captions.size, fallback.captions.size, 42, 96),
      position: pick(captions.position, ["下方", "中下"] as const, fallback.captions.position),
      keywordHighlight: bool(captions.keywordHighlight, fallback.captions.keywordHighlight),
    },
    keywordPunch: {
      enabled: bool(keywordPunch.enabled, fallback.keywordPunch.enabled),
      scale: clamp(keywordPunch.scale, fallback.keywordPunch.scale, 100, 135),
      density: pick(keywordPunch.density, ["只放金句", "标准", "强化"] as const, fallback.keywordPunch.density),
    },
    flowerText: {
      enabled: bool(flowerText.enabled, fallback.flowerText.enabled),
      style: pick(flowerText.style, ["粉白杂志", "黑白画报", "极简标签"] as const, fallback.flowerText.style),
      density: pick(flowerText.density, ["克制", "标准", "强化"] as const, fallback.flowerText.density),
    },
    tracking: {
      enabled: bool(tracking.enabled, fallback.tracking.enabled),
      followFace: bool(tracking.followFace, fallback.tracking.followFace),
      intensity: clamp(tracking.intensity, fallback.tracking.intensity, 0, 30),
    },
    animation: {
      enabled: bool(animation.enabled, fallback.animation.enabled),
      style: pick(animation.style, ["轻推近", "杂志滑入", "呼吸缩放"] as const, fallback.animation.style),
      intensity: clamp(animation.intensity, fallback.animation.intensity, 0, 100),
    },
    transitions: {
      enabled: bool(transitions.enabled, fallback.transitions.enabled),
      style: pick(transitions.style, ["无感叠化", "节奏硬切", "柔和闪白"] as const, fallback.transitions.style),
      durationMs: clamp(transitions.durationMs, fallback.transitions.durationMs, 80, 800),
    },
    effects: {
      enabled: bool(effects.enabled, fallback.effects.enabled),
      style: pick(effects.style, ["原片优先", "冷白时装", "轻颗粒"] as const, fallback.effects.style),
      intensity: clamp(effects.intensity, fallback.effects.intensity, 0, 100),
    },
    soundEffects: {
      enabled: bool(soundEffects.enabled, fallback.soundEffects.enabled),
      density: pick(soundEffects.density, ["克制", "标准", "强化"] as const, fallback.soundEffects.density),
      volume: clamp(soundEffects.volume, fallback.soundEffects.volume, 0, 100),
    },
    bgm: {
      enabled: bool(bgm.enabled, fallback.bgm.enabled),
      mood: pick(bgm.mood, ["轻电子", "时装律动", "柔和氛围"] as const, fallback.bgm.mood),
      volume: clamp(bgm.volume, fallback.bgm.volume, 0, 30),
      autoDucking: bool(bgm.autoDucking, fallback.bgm.autoDucking),
    },
  };
}
