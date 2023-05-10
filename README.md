# Profiling2

This repository includes the `!Profiling2` addon as well as the [site](https://wowprof.emallson.net)
used to examine its data.

## The Addon

The `!Profiling2` addon is a performance data collection addon for World of Warcraft. Unlike most
CPU profiling addons, its aim is to capture the [long tail](https://en.wikipedia.org/wiki/Long_tail)
of the performance distribution.

The idea is that _most_ addons perform well _most_ of the time, so the average is not very useful.
Instead, we are interested in addons (and WeakAuras, Plater mods, etc) that sometimes have _very
bad_ performance. Even if they usually perform okay, this can still cause annoying or problematic
framerate issues.

## Usage

This addon is intended to be used "expert-in-the-loop" style: you should only install this at the
direction of someone who knows what it is doing and knows how to read the results.

Usability by a general audience is an explicit non-goal.

### Installation & Setup

1. Download the latest release from the sidebar and install it the old fashioned way (unzip in your
   addons folder)
2. Run `/p2 status` in to confirm that it is installed correctly.
3. Run `/p2 enable` to enable script profiling.
4. (Optional) Use `/p2 teststart` and `/p2 teststop` to confirm that the addon doesn't break the
   world while profiling.

The addon will automatically begin recording when you start a raid encounter or Mythic+ dungeon, and
save the data out when you complete a raid encounter or **successfully** complete a Mythic+ dungeon
(Blizzard doesn't fire an event for failed M+ runs).

## Usage For Addon Developers

If you're interested in using this for addon development, a subset of functionality is exposed via
`LibStub("Profiling2")`. See [`external.lua`](./src/external.lua) for the available methods.

## The Method

Full docs soon:tm: but this uses a modified [DDSketch](https://arxiv.org/abs/1908.10693) approach to
track the amount of time taken at a _per render_ level (so many calls in the same render cycle are
coalesced into one data point). Data is tracked in 3 tiers:

- Tier 1: A simple counter for very fast ("trivial") runs.
- Tier 2: A `k`-min heap tracking the `k` longest seen runs above the "trivial" run cutoff.
- Tier 3: A `DDSketch` histogram for any non-trivial runs that "fall out" of the min heap.

Almost all scripts only use Tier 1 or Tier 2, which makes this very efficient---Tier 1 only
involves incrementing a number, while the small min heap used by Tier 2 is very quick.

Very few scripts (in theory) should have any data in Tier 3. As a result, the histogram is lazily
constructed on-demand. A pool of histogram storage is pre-allocated to avoid having to do any real
work during combat, but when the pool is exhausted it will create a new histogram (which involves
allocating a ~50 element array of 0s. Nothing too insane, but not free).

These metrics are recorded for:

- Every script of every frame of every non-Blizzard addon (by using a hook on the _metatable_ of a
  dummy frame)
- Every custom trigger of every loaded WA (by wrapping the code that loads scripts)
- Every custom trigger of every loaded Plater script/mod (similar approach, but somehow even
  spicier)
- Every core Plater method (listen, I wanna know if `Plater.CheckRange` has tail issues, okay?)

This is obviously **hilariously invasive** and any taint issues or strange bugs you run into are
_probably_ a result of running this.

**Please do not bother addon authors about errors encountered while using this addon.**
