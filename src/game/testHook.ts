import type { GameSession } from './core/gameSession';
import type { CompiledIsland } from './config/arenaLayout';
import type {
  EnemyEntity,
  GameEntity,
  PlayerEntity,
  ProjectileEntity,
} from './entities/entityModels';
import type { WeaponId } from './core/types';

/**
 * ============================================================================
 *  TEST HOOK — the E2E suite's window into the running simulation
 * ============================================================================
 *
 * WHAT IT IS FOR. A challenge suite must be able to verify behaviour that is not
 * otherwise observable: whether a shot actually left the hull, whether the score
 * moved exactly once for a kill, whether the ship is being held outside an
 * island. Reading React's rendered text cannot answer any of those, and the
 * alternative — driving assertions off screenshot pixels — is slower and far more
 * fragile. So the simulation gets one read surface.
 *
 * WHAT IT IS NOT. It cannot change the world. There is no spawn, no damage, no
 * teleport and no score setter: every mutation goes through the same input
 * controller and rule engine a player uses, so a passing test still proves the
 * game plays. The only capability beyond observation is `advance`, which moves
 * simulation TIME forward — the brief explicitly permits controlling the clock,
 * and it is what keeps "an enemy spawns within N seconds" from depending on how
 * loaded the CI machine happens to be.
 *
 * WHY IT IS SAFE. Every branch here is inside `import.meta.env.DEV`, which Vite
 * statically replaces with `false` for a production build; Rollup then drops the
 * module entirely. A shipped bundle contains no hook, no read surface and no way
 * to reach into the running match.
 */

export interface TestPlayerView {
  readonly x: number;
  readonly y: number;
  readonly angle: number;
  readonly health: number;
  readonly maxHealth: number;
  readonly alive: boolean;
  /** Hitbox radius — the bound the arena and island confinement resolve against. */
  readonly radius: number;
}

export interface TestEnemyView {
  readonly id: number;
  readonly kind: 'chaser' | 'shooter';
  readonly x: number;
  readonly y: number;
  readonly angle: number;
  readonly health: number;
  readonly maxHealth: number;
  readonly radius: number;
}

export interface TestProjectileView {
  readonly id: number;
  readonly owner: string;
  readonly weaponId: WeaponId;
  readonly x: number;
  readonly y: number;
  readonly angle: number;
}

export interface TestRectView {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * One island: its bounding box plus the exact solid tiles the collision pass
 * tests against.
 *
 * `bounds` alone cannot prove collision — a ship parked inside the bounding box
 * on a sea tile is perfectly legal. `solids` is what the rules engine actually
 * rejects, so an assertion against it cannot pass by accident of layout.
 */
export interface TestIslandView {
  readonly id: string;
  readonly bounds: TestRectView;
  readonly solids: readonly TestRectView[];
}

/** Arena extents and the margin the hull is confined inside. */
export interface TestArenaView {
  readonly width: number;
  readonly height: number;
  readonly boundsPadding: number;
}

export interface TestSnapshot {
  readonly phase: string;
  readonly score: number;
  readonly enemiesDefeated: number;
  readonly remainingMs: number;
  readonly simulationMs: number;
  readonly activeEntities: number;
  readonly spawnIntervalMs: number;
  readonly arena: TestArenaView;
  readonly player: TestPlayerView | null;
  readonly enemies: readonly TestEnemyView[];
  readonly projectiles: readonly TestProjectileView[];
  readonly islands: readonly TestIslandView[];
}

/**
 * Discrete simulation events counted since the hook was installed.
 *
 * Counters, not flags: "a shot was fired" proves nothing about the cooldown,
 * whereas "exactly one shot fired from two presses inside 380 ms" does.
 */
export interface TestCounters {
  readonly weaponFired: number;
  /** Volleys per weapon. Distinguishes a broadside from a bow shot at a glance. */
  readonly shotsByWeapon: Readonly<Record<WeaponId, number>>;
  readonly playerDamaged: number;
  readonly enemyDamaged: number;
  readonly enemyKilled: number;
  /** Chasers that reached the hull and exploded on their own terms. */
  readonly enemySelfDestructed: number;
}

export interface PbTestApi {
  /** Always true — lets a spec fail with a clear message if the hook is absent. */
  readonly installed: true;
  snapshot(): TestSnapshot;
  counters(): TestCounters;
  resetCounters(): void;
  /** Advances simulation time by `ms`, in loop-sized slices. No-op when paused. */
  advance(ms: number): void;
}

declare global {
  interface Window {
    __pbTest?: PbTestApi;
  }
}

/** Largest slice the loop accepts in one call — mirrors `DEFAULT_MAX_FRAME_MS`. */
const ADVANCE_SLICE_MS = 100;

/** A fresh, all-zero per-weapon tally. */
const emptyShots = (): Record<WeaponId, number> => ({
  player_front: 0,
  player_left: 0,
  player_right: 0,
  enemy_shooter: 0,
});

const playerView = (player: PlayerEntity): TestPlayerView => ({
  x: player.x,
  y: player.y,
  angle: player.angle,
  health: player.health,
  maxHealth: player.maxHealth,
  alive: player.alive,
  radius: player.radius,
});

const enemyView = (enemy: EnemyEntity): TestEnemyView => ({
  id: enemy.id,
  kind: enemy.kind,
  x: enemy.x,
  y: enemy.y,
  angle: enemy.angle,
  health: enemy.health,
  maxHealth: enemy.maxHealth,
  radius: enemy.radius,
});

const projectileView = (shot: ProjectileEntity): TestProjectileView => ({
  id: shot.id,
  owner: shot.owner,
  weaponId: shot.weaponId,
  x: shot.x,
  y: shot.y,
  angle: shot.angle,
});

const islandView = (island: CompiledIsland): TestIslandView => ({
  id: island.id,
  bounds: {
    x: island.bounds.x,
    y: island.bounds.y,
    width: island.bounds.width,
    height: island.bounds.height,
  },
  solids: island.solids.map((rect) => ({
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
  })),
});

/**
 * Installs the hook for one session and returns its removal.
 *
 * The returned disposer MUST run with the session: a stale hook left installed
 * after the match ends would let a spec read a destroyed world.
 */
export const installTestHook = (session: GameSession): (() => void) => {
  const world = session.world;

  let weaponFired = 0;
  let shotsByWeapon = emptyShots();
  let playerDamaged = 0;
  let enemyDamaged = 0;
  let enemyKilled = 0;
  let enemySelfDestructed = 0;

  const offFired = world.events.on('weapon:fired', ({ weaponId }) => {
    weaponFired += 1;
    shotsByWeapon[weaponId] += 1;
  });
  const offPlayerHit = world.events.on('player:damaged', () => {
    playerDamaged += 1;
  });
  // `entity:hit` covers both sides. The player's own hits are already counted by
  // `player:damaged`, so anything that is not the player is an enemy taking damage.
  // The id is resolved per hit because it is allocated when the match starts.
  const offEntityHit = world.events.on('entity:hit', ({ targetId }) => {
    if (targetId !== world.playerEntity?.id) enemyDamaged += 1;
  });
  const offEnemyDead = world.events.on('enemy:killed', () => {
    enemyKilled += 1;
  });
  // Self-destruction is a DIFFERENT event from a kill: it awards no score and
  // does not count as a defeated ship, so it gets its own counter rather than
  // being folded into `enemyKilled`.
  const offSelfDestruct = world.events.on('enemy:selfDestructed', () => {
    enemySelfDestructed += 1;
  });

  const api: PbTestApi = {
    installed: true,

    snapshot: () => {
      const enemies: TestEnemyView[] = [];
      const projectiles: TestProjectileView[] = [];
      let player: TestPlayerView | null = null;

      world.forEachEntity((entity: GameEntity) => {
        if (entity.kind === 'player') player = playerView(entity);
        else if (entity.kind === 'chaser' || entity.kind === 'shooter') enemies.push(enemyView(entity));
        else if (entity.kind === 'projectile') projectiles.push(projectileView(entity));
      });

      const stats = world.readStats();
      return {
        phase: world.matchPhase,
        score: stats.score,
        enemiesDefeated: stats.enemiesDefeated,
        remainingMs: stats.remainingMs,
        simulationMs: world.simulationTimeMs,
        activeEntities: stats.activeEntities,
        spawnIntervalMs: world.gameConfig.spawn.minIntervalSeconds * 1000,
        arena: {
          width: world.gameConfig.arena.width,
          height: world.gameConfig.arena.height,
          boundsPadding: world.gameConfig.arena.boundsPadding,
        },
        player,
        enemies,
        projectiles,
        islands: world.islands.map(islandView),
      };
    },

    counters: () => ({
      weaponFired,
      /* A COPY, not the live tally: `page.evaluate` serializes the whole result
         when it returns, so a shared object would hand every recorded step the
         value the script ended on. */
      shotsByWeapon: { ...shotsByWeapon },
      playerDamaged,
      enemyDamaged,
      enemyKilled,
      enemySelfDestructed,
    }),

    resetCounters: () => {
      weaponFired = 0;
      shotsByWeapon = emptyShots();
      playerDamaged = 0;
      enemyDamaged = 0;
      enemyKilled = 0;
      enemySelfDestructed = 0;
    },

    advance: (ms: number) => {
      let remaining = Math.max(0, ms);
      while (remaining > 0) {
        const slice = Math.min(remaining, ADVANCE_SLICE_MS);
        session.advanceManually(slice);
        remaining -= slice;
      }
    },
  };

  window.__pbTest = api;

  return () => {
    offFired();
    offPlayerHit();
    offEntityHit();
    offEnemyDead();
    offSelfDestruct();
    if (window.__pbTest === api) delete window.__pbTest;
  };
};
