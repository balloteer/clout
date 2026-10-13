// Android 36 emulator test helper; run as adb shell, never include in the app.
// Fixed event times model regular touch sampling despite a slow software renderer.
// argv: x, starting y, ending y, duration in milliseconds. See docs/android.md.
import android.os.SystemClock;
import android.view.InputDevice;
import android.view.InputEvent;
import android.view.MotionEvent;
import java.lang.reflect.Method;

public final class CloutSwipe {
  public static void main(String[] args) throws Exception {
    if (args.length != 4) throw new IllegalArgumentException("Expected x, fromY, toY, durationMs");
    float x = Float.parseFloat(args[0]);
    float from = Float.parseFloat(args[1]);
    float to = Float.parseFloat(args[2]);
    int duration = Integer.parseInt(args[3]);
    if (!Float.isFinite(x) || !Float.isFinite(from) || !Float.isFinite(to)
        || duration < 1 || duration > 5000) {
      throw new IllegalArgumentException("Coordinates must be finite; duration must be 1–5000 ms");
    }
    Class<?> managerType = Class.forName("android.hardware.input.InputManagerGlobal");
    Object manager = managerType.getMethod("getInstance").invoke(null);
    Method inject = managerType.getMethod("injectInputEvent", InputEvent.class, int.class);
    long down = SystemClock.uptimeMillis() + 30;
    int steps = Math.max(2, (int)Math.ceil(duration / 16.0));
    for (int i = 0; i <= steps + 1; i++) {
      int elapsed = i > steps ? duration + 16 : Math.round(duration * i / (float)steps);
      long when = down + elapsed;
      long wait = when - SystemClock.uptimeMillis();
      if (wait > 0) SystemClock.sleep(wait);
      int action = i == 0 ? MotionEvent.ACTION_DOWN : i > steps ? MotionEvent.ACTION_UP : MotionEvent.ACTION_MOVE;
      float y = i > steps ? to : from + (to - from) * i / steps;
      MotionEvent event = MotionEvent.obtain(down, when, action, x, y, 0);
      event.setSource(InputDevice.SOURCE_TOUCHSCREEN);
      if (!Boolean.TRUE.equals(inject.invoke(manager, event, 0))) throw new IllegalStateException("Input rejected");
      event.recycle();
    }
    System.out.println("Injected " + (steps + 2) + " asynchronous events over " + (duration + 16) + " ms");
  }
}
