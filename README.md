# Profiling2

This repository includes the `!Profiling2` addon as well as the [site](https://wowprof.emallson.net)
used to examine its data.

## The Addon

The `!Profiling2` addon is a performance data collection addon for World of Warcraft. Unlike most
CPU profiling addons, its aim is to capture the [long tail](https://en.wikipedia.org/wiki/Long_tail)
of the performance distribution.

The idea is that *most* addons perform well *most* of the time, so the average is not very useful.
Instead, we are interested in addons (and WeakAuras, Plater mods, etc) that sometimes have *very
bad* performance. Even if they usually perform okay, this can still cause annoying or problematic
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

Full docs soon:tm: but this uses various statistical methods to efficiently capture distributional
information. Specifically, it uses:

 - Online Moment Estimation
 - Online Quantile Estimation
 - Reservoir Sampling
 - A simple top-`k` max heap for worst observations

These metrics are recorded for:

 - Every script of every frame of every non-Blizzard addon (by using a hook on the *metatable* of a
   dummy frame)
 - Every custom trigger of every loaded WA (by wrapping the code that loads scripts)
 - Every custom trigger of every loaded Plater script/mod (similar approach, but somehow even
   spicier)
 - Every core Plater method (listen, I wanna know if `Plater.CheckRange` has tail issues, okay?)

This is obviously **hilariously invasive** and any taint issues or strange bugs you run into are
*probably* a result of running this.

**Please do not bother addon authors about errors encountered while using this addon.**
