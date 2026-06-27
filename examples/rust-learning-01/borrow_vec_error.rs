fn main() {
    let mut v = Vec::with_capacity(1);
    v.push(10);

    let view = &v;
    v.push(20);

    println!("view = {view:?}");
}
